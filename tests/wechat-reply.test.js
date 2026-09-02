'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { needsDsh, buildDirectMessages } = require('../core/agent/wechat-reply');

test('needsDsh：普通闲聊不走 DSH，疑似工具任务走 DSH', () => {
  assert.strictEqual(needsDsh('你好'), false);
  assert.strictEqual(needsDsh('今天过得怎么样'), false);
  assert.strictEqual(needsDsh('帮我查一下明天的天气'), true);
  assert.strictEqual(needsDsh('打开桌面的 report.xlsx 帮我整理一下'), true);
  assert.strictEqual(needsDsh('运行 node 脚本处理这个文件'), true);
});

test('buildDirectMessages：把会话历史转成直连模型 messages', () => {
  const messages = buildDirectMessages([
    { role: 'user', text: '你好' },
    { role: 'bot', text: '你好，有什么可以帮你？' }
  ], '今天天气如何？');

  assert.strictEqual(messages[0].role, 'system');
  assert.strictEqual(messages[1].role, 'user');
  assert.strictEqual(messages[1].content, '你好');
  assert.strictEqual(messages[2].role, 'assistant');
  assert.strictEqual(messages[2].content, '你好，有什么可以帮你？');
  assert.deepStrictEqual(messages[messages.length - 1], {
    role: 'user',
    content: '今天天气如何？'
  });
});
