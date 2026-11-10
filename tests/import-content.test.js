'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.XIAOTIHU_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pelican-import-content-'));
let handler;
require('../core/api/routes/import')({ post(route, callback) { if (route === '/api/import/content') handler = callback; } }, {
  json(response, status, body) { Object.assign(response, { status, body }); }
});

async function call(body) {
  const response = {};
  const request = { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
  await handler(request, response);
  return response;
}

test('copied messages require a nickname before import and retain sender ownership', async () => {
  const text = '本人昵称\n2026年11月6日 10:00\n早上好\n\n小明\n2026年11月6日 10:01\n你好';
  assert.equal((await call({ mode: 'clipboard', text })).status, 400);
  const response = await call({ mode: 'clipboard', text, selfNickname: '本人昵称' });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body.contacts), ['小明']);
  const messages = require('../core/memory/chat-db').messages('小明').messages;
  assert.equal(messages.find(message => message.name === '本人昵称').isOwner, true);
  assert.equal((await call({ mode: 'clipboard', text, selfNickname: '本人昵称' })).body.added, 0);
});

test('ChatLab file content imports through the same endpoint with owner ID', async () => {
  const text = [
    { _type: 'header', chatlab: { version: '0.0.2' }, meta: { type: 'private', name: '小红', ownerId: 'me' } },
    { _type: 'message', sender: 'me', accountName: '我的另一个昵称', timestamp: 1703001600, type: 0, content: '你好' },
    { _type: 'message', sender: 'other', accountName: '小红', timestamp: 1703001610, type: 0, content: '晚上见' }
  ].map(row => JSON.stringify(row)).join('\n');
  const response = await call({ mode: 'file', filename: 'export.jsonl', text });
  assert.equal(response.status, 200);
  assert.equal(response.body.format, 'chatlab');
  assert.equal(response.body.added, 2);
  assert.deepEqual(Object.keys(response.body.contacts), ['小红']);
});
