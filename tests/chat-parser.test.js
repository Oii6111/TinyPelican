'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseChatText, parseBlockFormat, parseLineFormat, classifyContent, getBatchContact
} = require('../core/lib/chat-parser');

test('块格式：昵称/时间/内容 三段式', () => {
  const text = 'Hank\n2026年08月16日 20:35\n拿喜茶顺便逛街去了\n\nDorveille.\n2026年08月16日 20:35\n要排队啊';
  const msgs = parseChatText(text);
  assert.strictEqual(msgs.length, 2);
  assert.deepStrictEqual(msgs[0], { name: 'Hank', ts: '2026-08-16 20:35', type: 'text', content: '拿喜茶顺便逛街去了' });
  assert.strictEqual(msgs[1].name, 'Dorveille.');
});

test('单行格式', () => {
  const text = 'Hank 2026年08月16日 20:35 拿喜茶顺便逛街去了\nDorveille. 2026年08月16日 20:35 要排队啊';
  const msgs = parseLineFormat(text);
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].content, '拿喜茶顺便逛街去了');
  assert.strictEqual(msgs[1].ts, '2026-08-16 20:35');
});

test('占位符分类', () => {
  assert.deepStrictEqual(classifyContent('[图片]'), { type: '图片', content: '' });
  assert.deepStrictEqual(classifyContent('[语音]'), { type: '语音', content: '' });
  assert.deepStrictEqual(classifyContent('[捂脸]'), { type: 'text', content: '[捂脸]' });
  assert.deepStrictEqual(classifyContent('正常文本'), { type: 'text', content: '正常文本' });
});

test('块格式解析单个消息（不足 2 条时退回单行解析）', () => {
  const msgs = parseBlockFormat('Hank\n2026年08月16日 20:35\n你好');
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(msgs[0].content, '你好');
});

test('群聊判断：多个非自己昵称视为群聊（无归属）', () => {
  const msgs = [{ name: 'Hank' }, { name: '杨勇' }, { name: '六壹' }];
  assert.strictEqual(getBatchContact(msgs, ['六壹']), '');
  const two = [{ name: 'Hank' }, { name: '六壹' }];
  assert.strictEqual(getBatchContact(two, ['六壹']), 'Hank');
});
