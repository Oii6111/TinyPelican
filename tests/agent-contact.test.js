'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.XIAOTIHU_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-agent-contact-'));

const chatDb = require('../core/memory/chat-db');
const { findMentionedContact, getContactContext, searchChat } = require('../core/agent/system-tools');
const { formatContactContext } = require('../core/agent/dsh-reply');

test('Agent 按备注定位联系人并读取分层画像和聊天', () => {
  chatDb.ingestMessages('微信昵称甲', [{ name: '微信昵称甲', ts: new Date().toISOString(), content: '周末见面' }]);
  chatDb.updateMember('微信昵称甲', { remark: '小月', profile: { '基础身份': { '所在地': '苏州' } } });

  assert.equal(findMentionedContact('帮我看看小月最近聊了什么')?.name, '微信昵称甲');
  assert.equal(searchChat('周末', { contact: '小月' }).length, 1);
  const context = formatContactContext(getContactContext('小月'));
  assert.match(context, /备注：小月/);
  assert.match(context, /基础身份：所在地：苏州/);
  assert.doesNotMatch(context, /\[object Object\]/);
});

test('相同备注对应多人时不自动选错联系人', () => {
  chatDb.ingestMessages('微信昵称乙', [{ name: '微信昵称乙', ts: new Date().toISOString(), content: '你好' }]);
  chatDb.updateMember('微信昵称乙', { remark: '小月' });
  assert.equal(findMentionedContact('小月最近怎么样'), null);
});
