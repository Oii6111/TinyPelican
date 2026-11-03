'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseChatText, parseChatDetail, parseBlockFormat, parseLineFormat, classifyContent, looksLikeChatText, getBatchContact
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

test('块格式解析单个消息（parseBlockFormat 直接可用）', () => {
  const msgs = parseBlockFormat('Hank\n2026年08月16日 20:35\n你好');
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(msgs[0].content, '你好');
});

test('复制单条聊天消息也要解析出来（只有一个块）', () => {
  const detail = parseChatDetail('Hank\n2026年08月16日 20:35\n明天下午三点开会');
  assert.strictEqual(detail.messages.length, 1);
  assert.deepStrictEqual(detail.messages[0], {
    name: 'Hank', ts: '2026-08-16 20:35', type: 'text', content: '明天下午三点开会'
  });
  // 一条块格式消息 = 3 行：默认门槛「最少匹配行数 2」也放行
  assert.strictEqual(detail.matchedLines, 3);
  assert.strictEqual(parseChatText('Hank\n2026年08月16日 20:35\n明天下午三点开会').length, 1);
});

test('跨天分隔行不会把第一条消息吃掉', () => {
  const text = '2026年08月16日 20:35\nHank\n2026年08月16日 20:35\n明天下午三点开会';
  const msgs = parseChatText(text);
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(msgs[0].name, 'Hank');
  assert.strictEqual(msgs[0].content, '明天下午三点开会');
});

test('单行格式仍走单行解析，并报告匹配 1 行', () => {
  const detail = parseChatDetail('Hank 2026年08月16日 20:35 拿喜茶');
  assert.strictEqual(detail.messages.length, 1);
  assert.strictEqual(detail.messages[0].name, 'Hank');
  assert.strictEqual(detail.matchedLines, 1);
});

test('looksLikeChatText：区分聊天文本与普通文本', () => {
  assert.strictEqual(looksLikeChatText('Hank\n2026年08月16日 20:35\n你好'), true);
  assert.strictEqual(looksLikeChatText('Hank 2026年08月16日 20:35 你好'), true);
  assert.strictEqual(looksLikeChatText('今天天气不错'), false);
});

test('群聊判断：多个非自己昵称视为群聊（无归属）', () => {
  const msgs = [{ name: 'Hank' }, { name: '杨勇' }, { name: '六壹' }];
  assert.strictEqual(getBatchContact(msgs, ['六壹']), '');
  const two = [{ name: 'Hank' }, { name: '六壹' }];
  assert.strictEqual(getBatchContact(two, ['六壹']), 'Hank');
});
