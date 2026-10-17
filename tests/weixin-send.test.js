'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const http = require('node:http');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tinypelican-weixin-send-'));
process.env.XIAOTIHU_DATA_DIR = directory;
const { WeChatClient } = require('../core/channels/weixin/client');
const { saveBuffer } = require('../core/channels/weixin/media');
const { prepareReply, deliverReply } = require('../core/channels/weixin/delivery');
const { readBinaryBody } = require('../core/api/routes/wechat-media');
const { createRouter } = require('../core/api/router');
const { getContext, setContext } = require('../core/channels/weixin/context');
const conversations = require('../core/memory/stores/conversations');
after(() => fs.rmSync(directory, { recursive: true, force: true }));

test('iLink file send encrypts bytes and sends caption and file separately', async (context) => {
  const record = await saveBuffer(Buffer.from('document bytes'), { name: '报告.pdf' });
  const requests = [];
  let uploadRequest;
  context.mock.method(global, 'fetch', async (url, options) => {
    if (String(url).includes('getuploadurl')) {
      uploadRequest = JSON.parse(options.body);
      return new Response(JSON.stringify({ ret: 0, upload_param: 'upload-secret' }));
    }
    if (String(url).includes('/upload?')) {
      assert.notDeepEqual(Buffer.from(options.body), Buffer.from('document bytes'));
      assert.equal(options.headers.Authorization, undefined);
      return new Response('', { headers: { 'x-encrypted-param': 'download-secret' } });
    }
    if (String(url).includes('sendmessage')) {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ret: 0 }));
    }
    throw new Error('unexpected request');
  });
  const client = new WeChatClient({ bot_token: 'test-token', account_id: 'test-account' });
  const result = await client.sendMedia('user', record, 'context', { text: '请看报告' });
  assert.equal(result.ok, true);
  assert.equal(result.textSent, true);
  assert.equal(uploadRequest.media_type, 3);
  assert.equal(uploadRequest.rawsize, record.size);
  assert.equal(uploadRequest.filesize, 16);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].msg.item_list[0].type, 1);
  const item = requests[1].msg.item_list[0];
  assert.equal(item.type, 4);
  assert.equal(item.file_item.file_name, record.name);
  assert.equal(item.file_item.len, String(record.size));
  assert.equal(Buffer.from(item.file_item.media.aes_key, 'base64').toString(), uploadRequest.aeskey);
});

test('iLink image send uses type 2 and ciphertext size; API errors are not success', async (context) => {
  const record = await saveBuffer(Buffer.from('89504e470d0a1a0a00000000', 'hex'), { name: 'photo.png' });
  const client = new WeChatClient({ account_id: 'test-account' });
  const messages = [];
  context.mock.method(client, '_post', async (endpoint, body) => {
    if (endpoint.includes('getuploadurl')) return { ok: true, data: { upload_param: 'test' } };
    messages.push(body.msg);
    return { ok: true, data: { ret: 0 } };
  });
  context.mock.method(global, 'fetch', async () => new Response('', { headers: { 'x-encrypted-param': 'encrypted' } }));
  assert.equal((await client.sendMedia('user', record, 'context')).ok, true);
  assert.equal(messages[0].item_list[0].type, 2);
  assert.equal(messages[0].item_list[0].image_item.mid_size, 16);
  context.mock.method(client, '_post', async () => ({ ok: true, data: { ret: 0, errcode: -14 } }));
  const failed = await client.sendText('user', 'hello', 'context');
  assert.equal(failed.ok, false);
  assert.equal(failed.staleToken, true);
});

test('MEDIA directives attach allowed files and never expose protected paths as text', async () => {
  const source = path.join(directory, 'result.txt');
  fs.writeFileSync(source, 'output');
  const config = path.join(directory, 'config.json');
  fs.writeFileSync(config, '{}');
  const prepared = await prepareReply(`完成了\nMEDIA:${source}\nMEDIA:${source}\nMEDIA:${config}`, { allowedRoots: [directory] });
  assert.equal(prepared.attachments.length, 1);
  assert.equal(prepared.errors.length, 1);
  assert.ok(prepared.text.includes('完成了'));
  assert.ok(!prepared.text.includes('MEDIA:'));
  assert.ok(!prepared.text.includes(config));
  const delivered = [];
  const result = await deliverReply({ send: async (message) => { delivered.push(message); return { ok: true }; } }, { to: 'user', ...prepared, contextToken: 'context' });
  assert.equal(result.ok, true);
  assert.equal(delivered.length, 2);
  assert.equal(result.attachments[0].path, undefined);
});

test('MEDIA directives reject application state, DSH credentials and database sidecars', async () => {
  const names = ['dsh-web-auth.json', 'dsh-email.json', 'remark-pending.json', 'voice-pending.json', 'intent-state.json', 'relation-pushed.json', 'unread.json', 'history.db', 'history.sqlite3', 'history.db-wal', 'api-token.json'];
  const forbidden = names.map(name => path.join(directory, name));
  for (const file of forbidden) fs.writeFileSync(file, 'private state fixture');
  const generated = path.join(directory, 'generated-report.json');
  fs.writeFileSync(generated, '{"result":"public artifact"}');
  const prepared = await prepareReply(['Generated report', ...forbidden.map(file => 'MEDIA:' + file), 'MEDIA:' + generated].join('\n'), { allowedRoots: [directory] });
  assert.equal(prepared.attachments.length, 1);
  assert.equal(prepared.attachments[0].name, 'generated-report.json');
  assert.equal(prepared.errors.length, names.length);
  for (const file of forbidden) assert.ok(!prepared.text.includes(file));
});

test('partial media delivery retains successes and does not retry completed sends', async () => {
  let calls = 0;
  const channel = { send: async () => { calls++; return calls < 3 ? { ok: true } : { ok: false, error: 'failed' }; } };
  const first = await saveBuffer(Buffer.from('one'), { name: 'one.txt' });
  const second = await saveBuffer(Buffer.from('two'), { name: 'two.txt' });
  const result = await deliverReply(channel, { to: 'user', text: 'caption', attachments: [first, second] });
  assert.equal(result.ok, false);
  assert.equal(result.text, 'caption');
  assert.equal(result.attachments.length, 1);
  assert.equal(calls, 3);
});

test('binary upload supports bodies above text limit and rejects size and interrupted streams', async () => {
  const stream = Readable.from([Buffer.alloc(1024 * 1024), Buffer.from('end')]);
  stream.headers = {};
  assert.equal((await readBinaryBody(stream)).length, 1024 * 1024 + 3);
  const oversized = Readable.from([Buffer.alloc(8)]);
  oversized.headers = {};
  await assert.rejects(readBinaryBody(oversized, 7), (error) => error.status === 413);
  const interrupted = new Readable({ read() { this.destroy(new Error('aborted')); } });
  interrupted.headers = {};
  await assert.rejects(readBinaryBody(interrupted), /上传中断/);
});

test('media API uploads, safely downloads and records only successful explicit sends', async (context) => {
  const router = createRouter();
  const apiContext = {
    json: (response, code, value) => { response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); },
    readBody: async (request) => { const chunks = []; for await (const chunk of request) chunks.push(chunk); return Buffer.concat(chunks).toString(); }
  };
  require('../core/api/routes/wechat')(router, apiContext);
  const server = http.createServer(async (request, response) => {
    try {
      if (!await router.match(request, response, apiContext)) apiContext.json(response, 404, {});
    } catch (error) { apiContext.json(response, 500, { error: error.message }); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(base + '/api/wechat/media', { method: 'POST', headers: { 'X-Filename': encodeURIComponent('报告.pdf') }, body: Buffer.from('file contents') });
    assert.equal(response.status, 201);
    const uploaded = await response.json();
    assert.equal(uploaded.attachment.name, '报告.pdf');
    assert.equal(uploaded.attachment.path, undefined);
    const downloaded = await fetch(base + uploaded.attachment.downloadUrl);
    assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff');
    assert.match(downloaded.headers.get('content-disposition'), /^attachment;/);
    assert.equal(await downloaded.text(), 'file contents');
    assert.equal((await fetch(base + '/api/wechat/media/no-such-id')).status, 404);
    const credentialsPath = path.join(directory, 'config.toml');
    fs.rmSync(credentialsPath, { force: true });
    const body = { attachmentId: uploaded.attachment.id, text: '说明' };
    const send = () => fetch(base + '/api/wechat/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await send()).status, 409);
    fs.writeFileSync(credentialsPath, '[weixin]\nbot_token = "test"\naccount_id = "account"\nuser_id = "owner"\n');
    assert.equal((await send()).status, 409);
    setContext('account', 'owner', 'test-context');
    context.mock.method(WeChatClient.prototype, 'sendMedia', async (to, record, token, options) => {
      assert.equal(to, 'owner'); assert.equal(token, 'test-context'); assert.equal(options.text, '说明');
      return { ok: false, error: 'test failure' };
    });
    assert.equal((await send()).status, 502);
    assert.equal(conversations.get('agent:main:weixin:owner').length, 0);
    setContext('account', 'owner', 'outdated-context');
    context.mock.method(WeChatClient.prototype, 'sendMedia', async (to, record, token) => {
      assert.equal(token, 'outdated-context');
      setContext('account', 'owner', 'new-inbound-context');
      return { ok: false, staleToken: true, error: 'expired context' };
    });
    assert.equal((await send()).status, 502);
    assert.equal(getContext('account', 'owner'), 'new-inbound-context');
    assert.equal(conversations.get('agent:main:weixin:owner').length, 0);
    context.mock.method(WeChatClient.prototype, 'sendMedia', async () => ({ ok: true, textSent: true }));
    assert.equal((await send()).status, 200);
    const messages = conversations.get('agent:main:weixin:owner');
    assert.equal(messages[0].text, '说明');
    assert.equal(messages[0].attachments[0].id, uploaded.attachment.id);
    assert.equal(messages[0].attachments[0].path, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
