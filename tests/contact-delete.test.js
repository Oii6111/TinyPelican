'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('联系人删除与清空聊天记录', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-contacts-'));
  process.env.XIAOTIHU_DATA_DIR = tmp;
  delete require.cache[require.resolve('../core/lib/paths')];
  delete require.cache[require.resolve('../core/memory/stores/contacts')];
  const P = require('../core/lib/paths').getPaths();
  const contacts = require('../core/memory/stores/contacts');

  fs.mkdirSync(P.contacts, { recursive: true });
  const doc = contacts.readContact('张三');
  doc.messages = [
    { name: '张三', ts: '2026-01-01', type: 'text', content: '你好' },
    { name: '我', ts: '2026-01-02', type: 'text', content: '在的' }
  ];
  contacts.saveContact(doc);
  fs.writeFileSync(P.inbox, JSON.stringify({ contact: '张三', name: '张三', content: '你好' }) + '\n' + JSON.stringify({ contact: '李四', name: '李四', content: '别删' }) + '\n', 'utf8');

  const updated = contacts.updateContact('张三', { remark: '老板', profile: { '近况': '很忙' } });
  assert.strictEqual(updated.remark, '老板');
  assert.strictEqual(updated.profile['近况'], '很忙');

  const cleared = contacts.clearContactMessages('张三');
  assert.strictEqual(cleared.removed, 2);
  assert.strictEqual(cleared.inboxRemoved, 1);
  assert.deepStrictEqual(contacts.readContact('张三').messages, []);
  assert.ok(fs.existsSync(contacts.contactFile('张三')));

  const inbox = fs.readFileSync(P.inbox, 'utf8');
  assert.ok(!inbox.includes('张三'));
  assert.ok(inbox.includes('李四'));

  const removed = contacts.deleteContact('张三');
  assert.strictEqual(removed.removed, true);
  assert.ok(!fs.existsSync(contacts.contactFile('张三')));

  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.XIAOTIHU_DATA_DIR;
});
