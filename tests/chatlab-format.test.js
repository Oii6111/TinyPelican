'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseChatLab } = require('../core/import/chatlab');

test('ChatLab JSONL resolves names, seconds and owner while ignoring metadata and bad lines', () => {
  const text = [
    '# exported chat',
    JSON.stringify({ _type: 'header', chatlab: { version: '0.0.2' }, meta: { name: '小明', type: 'private', ownerId: 'self' } }),
    JSON.stringify({ _type: 'member', platformId: 'self', accountName: '本人昵称' }),
    JSON.stringify({ _type: 'member', platformId: 'other', accountName: '小明' }),
    '{bad json',
    JSON.stringify({ _type: 'message', sender: 'self', timestamp: 1703001600, type: 0, content: '你好' }),
    JSON.stringify({ _type: 'message', sender: 'other', timestamp: 1703001610, type: 1, content: null })
  ].join('\n');
  const result = parseChatLab(text);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].name, '本人昵称');
  assert.equal(result.messages[0].ts, new Date(1703001600000).toISOString());
  assert.deepEqual(result.ownerNames, ['本人昵称']);
  assert.equal(result.messages[1].type, 'image');
  assert.equal(result.messages[1].content, '[image]');
  assert.equal(result.contactHint, '小明');
});

test('ChatLab JSON uses accountName rather than sender ID and preserves text', () => {
  const result = parseChatLab(JSON.stringify({ chatlab: { version: '0.0.2' }, meta: { name: '对方' }, messages: [{ sender: 'id-1', accountName: '对方', timestamp: 1703001600, type: 0, content: '晚点见' }] }));
  assert.equal(result.messages[0].name, '对方');
  assert.equal(result.messages[0].content, '晚点见');
  assert.equal(result.messages[0].type, 'text');
});

test('ordinary TXT and generic JSONL fall back to existing parsers', () => {
  assert.equal(parseChatLab('小明\n2026-11-06 12:00\n你好'), null);
  assert.equal(parseChatLab('{"sender":"小明","content":"你好"}'), null);
});
