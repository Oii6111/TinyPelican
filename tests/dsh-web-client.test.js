// DSH WebUI 客户端（对接 dsh 0.1.5+）：
//  - 内置 BrowserAuth：?token= 换 cookie，之后所有 /api 请求都要带 cookie；
//  - 接口是 Typert Remote：`ns/method` + payload.args。
// 这里用一个假 DSH 服务把认证流程和整条收发链路跑一遍。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-dshweb-'));
process.env.XIAOTIHU_DATA_DIR = tmp;

const webAuth = require('../core/agent/dsh-web-auth');
const dshWeb = require('../core/agent/dsh-web-client');

const TOKEN = 'test-token-abcdefgh';
const COOKIE = 'dsh-auth-test=v1.payload.sig';

function respond(res, value) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'server-response', rpcId: 'r-' + Math.random().toString(36).slice(2, 8), result: { ok: true, value } }));
}

function fail(res, message) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'server-response', rpcId: 'r', result: { ok: false, error: { code: 'gateway/bad-request', message, details: {} } } }));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try { return JSON.parse(body || '{}'); } catch { return {}; }
}

// 假 DSH web：新版（v2）+ 鉴权
function startModernDsh({ uploadError = '', missingPromptOnce = false, steerFlow = false } = {}) {
  const state = { authed: false, calls: [], prompts: [], uploads: [], pages: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    // 1) 令牌换 cookie
    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.get('token')) {
      if (url.searchParams.get('token') !== TOKEN) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        return res.end('unauthorized');
      }
      res.writeHead(303, { 'Set-Cookie': `${COOKIE}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`, Location: '/' });
      return res.end();
    }
    const endpoint = url.pathname.replace(/^\/api\//, '');
    const cookie = String(req.headers.cookie || '');
    // 2) 除根路径外一律要 cookie
    if (!cookie.includes(COOKIE.split('=')[0])) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      return res.end('unauthorized');
    }
    if (endpoint === 'session/uploadFileBinary') {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const receiptId = 'receipt-' + state.uploads.length;
      state.uploads.push({ sessionId: url.searchParams.get('sessionId'), name: url.searchParams.get('name'), bytes });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (uploadError) return res.end(JSON.stringify({ ok: false, error: { message: uploadError } }));
      return res.end(JSON.stringify({ ok: true, value: {
        receiptId, file: { attachmentId: 'sha256:fixture', name: url.searchParams.get('name'), bytes: bytes.length }
      } }));
    }
    const body = await readBody(req);
    const args = (body.payload && body.payload.args) || {};
    state.calls.push(endpoint);

    if (endpoint === 'session/list') {
      // 真实 0.1.5 这个接口要 _request，这里模拟参数名不一致的自动纠正
      if (!('_request' in args)) return fail(res, 'args fields do not match the descriptor: missing "_request"; unexpected "request"');
      return respond(res, { items: [{ sessionId: 'session-x', projections: { asOfSeq: 3 }, blank: false }] });
    }
    if (endpoint === 'workspace/create') {
      const request = args.request || args._request;
      return respond(res, { workspace: { workspaceId: 'ws-1', path: request.path, title: 'TinyPelican' } });
    }
    if (endpoint === 'session/create') {
      const request = args.request || args._request;
      return respond(res, { sessionId: request.sessionId });
    }
    if (endpoint === 'session/prompt') {
      const request = args.request || args._request;
      if (!request.requestId) return fail(res, 'args fields do not match the descriptor: missing "requestId"');
      state.prompts.push(request);
      if (missingPromptOnce && state.prompts.length === 1) return fail(res, 'session not found');
      return respond(res, { accepted: true });
    }
    if (endpoint === 'session/page') {
      state.pages += 1;
      const cursor = (args.request || args._request).throughSeq;
      if (cursor > (steerFlow ? 5 : 4)) return fail(res, `session page through seq ${cursor} is past cursor ${steerFlow ? 5 : 4}`);
      // 发消息之前日志里只有用户那条；发出去之后才有助手回复
      const records = [{ type: 'event', event: { type: 'user/message', seq: 1, time: 1, data: { message: { content: [{ type: 'text', text: 'hi' }] } } } }];
      if (steerFlow) {
        if (state.prompts.length) records.push({ type: 'event', event: { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: '首轮草稿' }] } } } });
        if (state.prompts.length > 1) {
          records.push({ type: 'event', event: { type: 'user/message', seq: 3, time: 3, data: { source: { rpcId: state.prompts[1].requestId }, message: { content: [{ type: 'text', text: '补充' }] } } } });
          records.push({ type: 'event', event: { type: 'assistant/message', seq: 4, time: 4, data: { message: { content: [{ type: 'text', text: '按补充说明后的最终回复' }] } } } });
          records.push({ type: 'event', event: { type: 'turn/end', seq: 5, time: 5, data: { reason: { kind: 'completed' } } } });
        }
      } else if (state.prompts.length) {
        records.push({ type: 'event', event: { type: 'assistant/message', seq: 3, time: 2, data: { message: { content: [{ type: 'text', text: '收到' }] } } } });
        records.push({ type: 'event', event: { type: 'turn/end', seq: 4, time: 3, data: { reason: { kind: 'completed' } } } });
      }
      return respond(res, { records, hasMore: false });
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state })));
}

test('sessionPrompt supplies images and generic files through native DSH attachments', async () => {
  webAuth._resetCache();
  const { server, state } = await startModernDsh();
  const base = `http://127.0.0.1:${server.address().port}`;
  const imagePath = path.join(tmp, 'channel-image.png');
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRFAAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(imagePath, imageBytes);
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ agent: { dsh: { webToken: TOKEN } } }), 'utf8');
  try {
    const result = await dshWeb.sessionPrompt({
      sessionId: 'media-session', text: 'describe this image', base,
      attachments: [
        { kind: 'image', path: imagePath, mimeType: 'image/png', name: 'photo.png' },
        { kind: 'file', path: imagePath, mimeType: 'application/octet-stream', name: 'data.bin' },
        { kind: 'image', path: imagePath, mimeType: 'image/png', status: 'failed' },
        { kind: 'image', path: path.join(tmp, 'missing.png'), mimeType: 'image/png' }
      ]
    });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(state.prompts[0].content, [
      { type: 'text', text: 'describe this image' },
      { type: 'image', mediaType: 'image/png', data: imageBytes.toString('base64'), name: 'photo.png' },
      { type: 'file', receiptId: 'receipt-0' }
    ]);
    assert.equal(state.uploads[0].name, 'data.bin');
    assert.deepEqual(state.uploads[0].bytes, imageBytes);
  } finally {
    server.close();
  }
});

test('DSH file upload failure is reported without sending a prompt missing its file', async () => {
  webAuth._resetCache();
  const { server, state } = await startModernDsh({ uploadError: 'attachment storage unavailable' });
  const base = `http://127.0.0.1:${server.address().port}`;
  const filePath = path.join(tmp, 'failed-upload.pdf');
  fs.writeFileSync(filePath, 'unchanged original file');
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ agent: { dsh: { webToken: TOKEN } } }), 'utf8');
  try {
    const result = await dshWeb.sessionPrompt({ sessionId: 'failed-file', text: 'read', base,
      attachments: [{ kind: 'file', name: 'example.pdf', path: filePath }] });
    assert.equal(result.ok, false);
    assert.match(result.error, /attachment storage unavailable/);
    assert.equal(state.prompts.length, 0);
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'unchanged original file');
  } finally {
    server.close();
  }
});

test('sessionPrompt forwards steer mode for an in-progress DSH turn', async () => {
  webAuth._resetCache();
  const { server, state } = await startModernDsh();
  const base = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ agent: { dsh: { webToken: TOKEN } } }), 'utf8');
  try {
    const result = await dshWeb.sessionPrompt({ sessionId: 'steer-session', text: '补充：请把重点放在图片中的第二个人', mode: 'steer', base });
    assert.equal(result.ok, true, result.error);
    assert.equal(state.prompts[0].mode, 'steer');
  } finally {
    server.close();
  }
});

test('promptAndWait waits for the final assistant message after a steer', async () => {
  webAuth._resetCache();
  const { server, state } = await startModernDsh({ steerFlow: true });
  const base = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ agent: { dsh: { webToken: TOKEN } } }), 'utf8');
  try {
    const waiting = dshWeb.promptAndWait({ sessionId: 'steer-flow', text: '先看这张图', base, timeoutMs: 10000, waitForTurnEnd: true });
    for (let attempt = 0; attempt < 50 && state.prompts.length < 1; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(state.prompts.length, 1);
    const steering = await dshWeb.sessionPrompt({ sessionId: 'steer-flow', text: '补充：重点看右侧人物', mode: 'steer', base });
    assert.equal(steering.ok, true, steering.error);
    const result = await waiting;
    assert.equal(result.ok, true, result.error);
    assert.equal(result.text, '按补充说明后的最终回复');
  } finally {
    server.close();
  }
});

test('recreated DSH sessions receive new file receipts instead of expired receipts', async () => {
  webAuth._resetCache();
  const { server, state } = await startModernDsh({ missingPromptOnce: true });
  const base = `http://127.0.0.1:${server.address().port}`;
  const filePath = path.join(tmp, 'retry-file.bin');
  fs.writeFileSync(filePath, Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ agent: { dsh: { webToken: TOKEN } } }), 'utf8');
  try {
    const result = await dshWeb.sessionPrompt({ sessionId: 'recreated-file', text: 'read', base,
      attachments: [{ kind: 'file', name: 'original.doc', path: filePath }] });
    assert.equal(result.ok, true, result.error);
    assert.equal(state.uploads.length, 2);
    assert.deepEqual(state.uploads[0].bytes, state.uploads[1].bytes);
    assert.equal(state.uploads[1].name, 'original.doc');
    assert.equal(state.prompts[0].content[1].receiptId, 'receipt-0');
    assert.equal(state.prompts[1].content[1].receiptId, 'receipt-1');
  } finally {
    server.close();
  }
});

test('令牌换 cookie + ns/method 接口 + 参数名自动纠正，整链路可收发', async () => {
  webAuth._resetCache();
  const { server, state } = await startModernDsh();
  const base = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ agent: { dsh: { webToken: TOKEN } } }), 'utf8');
  try {
    const r = await dshWeb.ask({ userId: 'selftest', text: '你好', base, timeoutMs: 15000, cwd: 'C:\\tmp' });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.text, '收到');

    // cookie 已落盘，重开进程也能复用（不用再拿令牌换）
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'dsh-web-auth.json'), 'utf8'));
    assert.ok(saved[base] && saved[base].cookie.startsWith('dsh-auth-'));
    // 轮询不再拉全量会话列表（一次近百 KB）：游标改用「越界探测」，只读很小的尾页
    assert.ok(!state.calls.includes('session/list'), '不该调用 session/list');
    assert.ok(state.calls.filter((c) => c === 'session/page').length >= 1, '应通过 session/page 读历史');
    assert.ok(state.calls.includes('workspace/create'));
    assert.ok(state.calls.includes('session/create'));
    assert.ok(state.calls.includes('session/prompt'));
    assert.ok(state.calls.includes('session/page'));
    assert.ok(state.prompts[0].requestId, 'prompt 必须带 requestId');
  } finally {
    server.close();
  }
});

test('模型侧失败（重试后本轮无回复）：不等超时，直接把原因报出来', async () => {
  webAuth._resetCache();
  const state = { prompts: [] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.searchParams.get('token')) {
      res.writeHead(303, { 'Set-Cookie': `${COOKIE}; Max-Age=2592000; Path=/`, Location: '/' });
      return res.end();
    }
    const endpoint = url.pathname.replace(/^\/api\//, '');
    if (!String(req.headers.cookie || '').includes('dsh-auth-')) { res.writeHead(401); return res.end('unauthorized'); }
    const body = await readBody(req);
    const args = (body.payload && body.payload.args) || {};
    if (endpoint === 'session/list') return respond(res, { items: [{ sessionId: 's', projections: { asOfSeq: 5 } }] });
    if (endpoint === 'workspace/create') return respond(res, { workspace: { workspaceId: 'ws' } });
    if (endpoint === 'session/create') return respond(res, { sessionId: (args.request || args._request).sessionId });
    if (endpoint === 'session/prompt') { state.prompts.push(1); return respond(res, { accepted: true }); }
    if (endpoint === 'session/page') {
      const cursor = (args.request || args._request).throughSeq;
      if (!state.prompts.length) return respond(res, { records: [], hasMore: false });
      if (cursor > 9) return fail(res, `session page through seq ${cursor} is past cursor 9`);
      // 模型 503 重试 5 次后本轮结束，没有 assistant/message
      return respond(res, {
        records: [
          { type: 'event', event: { type: 'user/message', seq: 6, data: { message: { content: [{ type: 'text', text: 'hi' }] } } } },
          { type: 'event', event: { type: 'llm/retry', seq: 7, data: { retry: 5, maxRetries: 5, failure: { message: 'OpenAI API error (503): {"code":"model_overloaded"}' } } } },
          { type: 'event', event: { type: 'step/end', seq: 8, data: {} } },
          { type: 'event', event: { type: 'turn/end', seq: 9, data: {} } }
        ],
        hasMore: false
      });
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ agent: { dsh: { webToken: TOKEN } } }), 'utf8');
  try {
    const started = Date.now();
    const r = await dshWeb.ask({ userId: 'failcase', text: '你好', base, timeoutMs: 60000, cwd: 'C:\\tmp' });
    const cost = Date.now() - started;
    assert.strictEqual(r.ok, false);
    assert.ok(/503|model_overloaded/.test(r.error), '错误里应带出模型侧原因：' + r.error);
    assert.ok(cost < 10000, '应当快速失败而不是等到超时，实际 ' + cost + 'ms');
  } finally {
    server.close();
  }
});

test('会话被清掉后：自动重建再重发（不回错也不抛异常）', async () => {
  webAuth._resetCache();
  const state = { created: [], prompts: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.searchParams.get('token')) {
      res.writeHead(303, { 'Set-Cookie': `${COOKIE}; Max-Age=2592000; Path=/`, Location: '/' });
      return res.end();
    }
    const endpoint = url.pathname.replace(/^\/api\//, '');
    if (!String(req.headers.cookie || '').includes('dsh-auth-')) { res.writeHead(401); return res.end('unauthorized'); }
    const body = await readBody(req);
    const args = (body.payload && body.payload.args) || {};
    const request = args.request || args._request || {};
    if (endpoint === 'session/create') {
      state.created.push(request.sessionId);
      return respond(res, { sessionId: request.sessionId });
    }
    if (endpoint === 'session/prompt') {
      // 只有建过档的会话才接受（模拟 DSH 重启 + 会话文件已被清掉）
      if (!state.created.includes(request.sessionId)) return fail(res, `session "${request.sessionId}" not found`);
      state.prompts += 1;
      return respond(res, { accepted: true });
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ agent: { dsh: { webToken: TOKEN } } }), 'utf8');
  try {
    const r = await dshWeb.sessionPrompt({ sessionId: 'session-gone', text: 'hi', base, cwd: 'C:\\tmp' });
    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual(state.created, ['session-gone'], '应先重建会话');
    assert.strictEqual(state.prompts, 1, '重建后应重发一次');
  } finally {
    server.close();
  }
});

test('没有令牌 / cookie 时，报错要给出可操作的指引（而不是只丢 401）', async () => {
  webAuth._resetCache();
  fs.rmSync(path.join(tmp, 'dsh-web-auth.json'), { force: true });
  delete process.env.DSH_WEB_TOKEN;
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({}), 'utf8');
  const { server } = await startModernDsh();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await dshWeb.ask({ userId: 'selftest', text: '你好', base, timeoutMs: 5000, cwd: 'C:\\tmp' });
    assert.strictEqual(r.ok, false);
    assert.ok(/unauthorized/.test(r.error), r.error);
    assert.ok(/token/i.test(r.error), '错误里应提示怎么补令牌：' + r.error);
  } finally {
    server.close();
  }
});
