// 前端「聊天导入」用的 POST /api/import/content：
// 文件/剪贴板文本 → 解析（ChatLab / 微信文本）→ 自昵称落盘 → 按联系人入库、去重。
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pelican-import-content-'));
process.env.XIAOTIHU_DATA_DIR = directory;

let handler;
require('../core/api/routes/import')({ post(route, callback) { if (route === '/api/import/content') handler = callback; } }, {
  json(response, status, body) { Object.assign(response, { status, body }); }
});
const { parseAny } = require('../core/import/chat-archive');

async function call(body) {
  const response = {};
  const request = { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
  await handler(request, response);
  return response;
}

after(() => {
  try { require('../core/memory/chat-db').db.close(); } catch {}
  fs.rmSync(directory, { recursive: true, force: true });
});

test('复制的聊天必须填本人昵称；导入后保留发送者归属并落盘自昵称', async () => {
  const text = '本人昵称\n2026年11月6日 10:00\n早上好\n\n小明\n2026年11月6日 10:01\n你好';
  assert.equal((await call({ mode: 'clipboard', text })).status, 400);
  const response = await call({ mode: 'clipboard', text, selfNickname: '本人昵称' });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body.contacts), ['小明']);
  const chatDb = require('../core/memory/chat-db');
  const messages = chatDb.messages('小明').messages;
  assert.equal(messages.find(message => message.name === '本人昵称').isOwner, true);
  assert.equal(messages.find(message => message.name === '小明').isOwner, false);
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
  assert.deepEqual(config.selfNicknames, ['本人昵称'], '自昵称应写进 config.json，供后续剪贴板导入复用');
  assert.equal((await call({ mode: 'clipboard', text, selfNickname: '本人昵称' })).body.added, 0, '重复导入应全部去重');
});

test('ChatLab JSONL 文件走同一接口，按 ownerId 区分本人', async () => {
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
  const messages = require('../core/memory/chat-db').messages('小红').messages;
  assert.deepEqual(messages.map(message => [message.name, message.isOwner, message.content]), [
    ['我的另一个昵称', true, '你好'],
    ['小红', false, '晚上见']
  ]);
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
  assert.ok(config.selfNicknames.includes('我的另一个昵称'), 'ChatLab 的本人昵称应并入 selfNicknames');
});

test('ChatLab 单 JSON 文件：没有 ownerId 时用 meta.name 兜底确定联系人', async () => {
  const text = JSON.stringify({
    chatlab: { version: '0.0.2' },
    meta: { type: 'private', name: '小美' },
    messages: [
      { sender: 'a', accountName: '阿', timestamp: 1703001600, type: 0, content: '在吗' },
      { sender: 'b', accountName: '乙', timestamp: 1703001610, type: 0, content: '在的' }
    ]
  });
  const response = await call({ mode: 'file', filename: 'chat.json', text });
  assert.equal(response.status, 200);
  assert.equal(response.body.format, 'chatlab');
  assert.deepEqual(Object.keys(response.body.contacts), ['小美']);
  assert.equal(response.body.added, 2);
});

test('多个本人昵称在文件导入里保持各自的归属', async () => {
  const text = '本人甲\n2026年11月6日 11:00\n早上好\n\n本人乙\n2026年11月6日 11:01\n再见\n\n小李\n2026年11月6日 11:02\n你好';
  const response = await call({ mode: 'file', filename: 'chat.txt', text, selfNickname: '本人甲，本人乙,本人甲' });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body.contacts), ['小李']);
  const messages = require('../core/memory/chat-db').messages('小李').messages;
  assert.equal(messages.filter(message => message.isOwner).length, 2);
  assert.equal(messages.find(message => message.content === '你好').isOwner, false);
});

test('格式校验与 parseAny 的 ChatLab 优先识别', async () => {
  assert.equal((await call({ mode: 'file', filename: 'chat.zip', text: 'x' })).status, 400);
  assert.equal((await call({ mode: 'file', filename: 'chat.txt', text: '没有任何时间戳的文本' })).status, 400);
  const chatlab = [{ _type: 'header', chatlab: { version: '0.0.2' }, meta: { name: '群一' } },
    { _type: 'message', sender: 'u1', accountName: '甲', timestamp: 1703001600, type: 0, content: '早' }]
    .map(row => JSON.stringify(row)).join('\n');
  assert.equal(parseAny(chatlab, 'x.jsonl').format, 'chatlab');
  const plain = parseAny('小明\n2026年11月6日 12:00\n你好', 'x.txt');
  assert.equal(plain.format, 'wechat', '不是 ChatLab 时仍回落到原有解析链');
});
