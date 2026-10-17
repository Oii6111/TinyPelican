'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const media = require('../core/channels/weixin/media');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/C5sAAAAASUVORK5CYII=', 'base64');

async function temporaryDirectory(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tinypelican-weixin-media-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function mockFetch(context, implementation) {
  const original = global.fetch;
  global.fetch = implementation;
  context.after(() => { global.fetch = original; });
}

function encryptedBuffer(bytes, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}

test('media cache persists safe names and rejects invalid identifiers and sidecar paths', async context => {
  const directory = await temporaryDirectory(context);
  const record = await media.saveBuffer(Buffer.from('hello'), { name: '..\\..\\secret.txt', directory });
  assert.equal(record.name, 'secret.txt');
  assert.equal(record.kind, 'file');
  assert.equal((await media.getMedia(record.id, { directory })).path, record.path);
  assert.equal(await media.getMedia('../../secret', { directory }), null);
  const attachment = media.publicAttachment(record);
  assert.equal(attachment.url, '/api/wechat/media/' + record.id);
  assert.equal(attachment.path, undefined);
  assert.equal(attachment.aesKey, undefined);
  await fs.writeFile(path.join(directory, record.id + '.json'), JSON.stringify({ ...record, path: path.join(directory, '..', record.id + '.bin') }));
  assert.equal(await media.getMedia(record.id, { directory }), null);
  const failed = media.publicAttachment({ kind: 'image', name: '../test.png', status: 'failed', error: 'https://cdn.weixin.qq.com?secret=key C:\\private' });
  assert.deepEqual(failed, { kind: 'image', name: 'test.png', status: 'failed', error: '媒体接收失败，请重试' });
});

test('image preview only uses recognized binary image content', async context => {
  const directory = await temporaryDirectory(context);
  const image = await media.saveBuffer(PNG, { name: 'misleading.exe', mimeType: 'text/html', directory });
  assert.equal(image.kind, 'image');
  assert.equal(image.mimeType, 'image/png');
  const explicitFile = await media.saveBuffer(PNG, { name: 'photo.png', kind: 'file', directory });
  assert.equal(explicitFile.kind, 'file');
  await assert.rejects(media.saveBuffer(Buffer.alloc(0), { directory }), /内容为空/);
  const svg = await media.saveBuffer(Buffer.from('<svg onload="alert(1)"></svg>'), { name: 'fake.png', kind: 'image', mimeType: 'image/svg+xml', directory });
  assert.equal(svg.kind, 'file');
  assert.equal(svg.mimeType, 'application/octet-stream');
});

test('CDN upload encrypts and retries server errors using no bot credentials', async context => {
  const directory = await temporaryDirectory(context);
  const record = await media.saveBuffer(PNG, { name: 'photo.png', kind: 'image', directory });
  let uploadRequest;
  let calls = 0;
  const client = { async getUploadUrl(body) { uploadRequest = body; return { ok: true, data: { upload_param: 'private-upload-token' } }; } };
  mockFetch(context, async (url, options) => {
    calls++;
    assert.equal(new URL(url).pathname, '/c2c/upload');
    assert.equal(new URL(url).searchParams.get('encrypted_query_param'), 'private-upload-token');
    assert.deepEqual(options.headers, { 'Content-Type': 'application/octet-stream' });
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from(uploadRequest.aeskey, 'hex'), null);
    assert.deepEqual(Buffer.concat([decipher.update(options.body), decipher.final()]), PNG);
    return calls < 3 ? new Response('', { status: 503 }) : new Response('', { status: 200, headers: { 'x-encrypted-param': 'download-token' } });
  });
  const uploaded = await media.uploadMedia(client, { record, to: 'contact@im.wechat' });
  assert.equal(calls, 3);
  assert.equal(uploadRequest.media_type, 1);
  assert.equal(uploadRequest.rawsize, PNG.length);
  assert.equal(uploadRequest.filesize, Math.ceil((PNG.length + 1) / 16) * 16);
  assert.equal(uploaded.encryptQueryParam, 'download-token');
  assert.equal(Buffer.from(uploaded.aesKey, 'base64').toString('ascii'), uploadRequest.aeskey);
  assert.equal(uploaded.md5, crypto.createHash('md5').update(PNG).digest('hex'));
});

test('CDN client errors do not retry and response error bodies stay private', async context => {
  const directory = await temporaryDirectory(context);
  const record = await media.saveBuffer(Buffer.from('document'), { name: 'report.txt', directory });
  let calls = 0;
  let requestedType;
  mockFetch(context, async () => { calls++; return new Response('secret URL and key', { status: 403 }); });
  const client = { async getUploadUrl(body) { requestedType = body.media_type; return { ok: true, data: { upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload?private=true' } }; } };
  await assert.rejects(media.uploadMedia(client, { record, to: 'contact' }), error => error.message.includes('403') && !error.message.includes('secret') && !error.message.includes('private'));
  assert.equal(calls, 1);
  assert.equal(requestedType, 3);
});

test('media URL checks block external URLs, credentials, ports and non-HTTPS', async context => {
  let calls = 0;
  mockFetch(context, async () => { calls++; throw new Error('should not request'); });
  for (const fullUrl of ['http://novac2c.cdn.weixin.qq.com/file', 'https://weixin.qq.com.evil.test/file', 'https://user:password@cdn.weixin.qq.com/file', 'https://127.0.0.1/file', 'https://cdn.weixin.qq.com:444/file']) {
    await assert.rejects(media.downloadItem({ type: 2, image_item: { media: { full_url: fullUrl } } }), /HTTPS|地址/);
  }
  assert.equal(calls, 0);
});

test('image download prefers full_url and hex key over media base64 key', async context => {
  const directory = await temporaryDirectory(context);
  const key = crypto.randomBytes(16);
  mockFetch(context, async (url, options) => {
    assert.equal(url, 'https://cdn.weixin.qq.com/original?opaque=private');
    assert.equal(options.headers, undefined);
    assert.equal(options.redirect, 'error');
    return new Response(encryptedBuffer(PNG, key));
  });
  const record = await media.downloadItem({ type: 2, image_item: { aeskey: key.toString('hex'), media: { full_url: 'https://cdn.weixin.qq.com/original?opaque=private', encrypt_query_param: 'unused', aes_key: 'not-valid' } } }, { directory });
  assert.equal(record.kind, 'image');
  assert.equal(record.direction, 'inbound');
  assert.deepEqual(await fs.readFile(record.path), PNG);
});

test('file download supports raw-base64 and base64-hex AES keys and integrity checks', async context => {
  const directory = await temporaryDirectory(context);
  const key = crypto.randomBytes(16);
  const bytes = Buffer.from('attachment');
  const md5 = crypto.createHash('md5').update(bytes).digest('hex');
  mockFetch(context, async url => {
    assert.equal(new URL(url).searchParams.get('encrypted_query_param'), 'opaque');
    return new Response(encryptedBuffer(bytes, key));
  });
  for (const aesKey of [key.toString('base64'), Buffer.from(key.toString('hex')).toString('base64')]) {
    const record = await media.downloadItem({ type: 4, file_item: { file_name: '../report.txt', md5, media: { encrypt_query_param: 'opaque', aes_key: aesKey } } }, { directory });
    assert.equal(record.name, 'report.txt');
    assert.deepEqual(await fs.readFile(record.path), bytes);
  }
  await assert.rejects(media.downloadItem({ type: 4, file_item: { media: { encrypt_query_param: 'opaque' } } }, { directory }), /缺少解密密钥/);
  await assert.rejects(media.downloadItem({ type: 4, file_item: { md5: '0'.repeat(32), media: { encrypt_query_param: 'opaque', aes_key: key.toString('base64') } } }, { directory }), /校验失败/);
});

test('stream download cancels an oversized response before buffering it', async context => {
  let cancelled = false;
  let released = false;
  mockFetch(context, async () => ({
    ok: true,
    status: 200,
    headers: { get() { return null; } },
    body: { getReader() { return {
      async read() { return { done: false, value: { byteLength: media.MAX_MEDIA_BYTES + 1 } }; },
      async cancel() { cancelled = true; },
      releaseLock() { released = true; }
    }; } }
  }));
  await assert.rejects(media.downloadItem({ type: 2, image_item: { media: { full_url: 'https://cdn.weixin.qq.com/file' } } }), /100 MB/);
  assert.equal(cancelled, true);
  assert.equal(released, true);
});

test('download rejects announced oversized media and sanitizes network failures', async context => {
  let cancelled = false;
  mockFetch(context, async () => ({ ok: true, status: 200, headers: { get() { return String(media.MAX_MEDIA_BYTES + 1); } }, body: { async cancel() { cancelled = true; } } }));
  const item = { type: 2, image_item: { media: { full_url: 'https://cdn.weixin.qq.com/file?secret=abc' } } };
  await assert.rejects(media.downloadItem(item), /100 MB/);
  assert.equal(cancelled, true);
  global.fetch = async () => { throw new Error('socket failure https://cdn.weixin.qq.com?secret=abc'); };
  await assert.rejects(media.downloadItem(item), error => error.message === '微信媒体传输失败，请重试');
});
