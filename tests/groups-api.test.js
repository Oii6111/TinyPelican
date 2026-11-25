'use strict';

// 群聊接口：GET /api/groups 列群、GET /api/groups/:name 取群详情（成员 + 最近消息）。
// 群不是人：非群（联系人 / 群成员）一律 404，不许静默当成群。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pelican-groups-'));
process.env.XIAOTIHU_DATA_DIR = directory;
const { createServer } = require('../core/server');
const chat = require('../core/memory/chat-db');
after(() => {
  chat.db.close();
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function startServer() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function stopServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

test('群聊接口：能列群、能取群详情（成员 + 最近消息），非群 404', async () => {
  // 群：身份名「项目群」，截图读到的真群名写进 remark
  chat.ingestMessages('项目群', [
    { name: '我', ts: '2026-11-20T10:00:00Z', content: '几点集合', isOwner: true },
    { name: '张三', ts: '2026-11-20T10:01:00Z', content: '九点', isOwner: false },
    { name: '李四', ts: '2026-11-20T10:02:00Z', content: '收到', isOwner: false }
  ], { kind: 'group', remark: '读书会' });
  chat.linkGroupMembers('项目群', ['张三', '李四', '刚子']);
  // 李四已经被用户加为联系人，剩下两个仍是群里的陌生人
  chat.promoteContact('李四');
  // 普通联系人：不能出现在群列表里，也不能当群查
  chat.ingestMessages('普通联系人', [
    { name: '我', ts: '2026-11-21T09:00:00Z', content: '在吗', isOwner: true },
    { name: '普通联系人', ts: '2026-11-21T09:01:00Z', content: '在的', isOwner: false }
  ]);

  const { server, base } = await startServer();
  const encoded = (value) => encodeURIComponent(value);
  try {
    // ---- 列表 ----
    const listResponse = await fetch(base + '/api/groups');
    assert.equal(listResponse.status, 200);
    const groups = await listResponse.json();
    assert.ok(Array.isArray(groups), '群列表要直接返回数组');
    assert.equal(groups.length, 1);
    const [group] = groups;
    assert.equal(group.name, '项目群');
    assert.equal(group.remark, '读书会');
    assert.equal(group.kind, 'group');
    assert.equal(group.memberCount, 3);
    assert.equal(group.messages, 3);
    assert.match(String(group.lastMessageAt), /^2026-11-20T10:02/);
    assert.ok(!groups.some((item) => item.name === '普通联系人' || item.name === '张三'), '群列表只包含群');
    // 联系人接口也不该把群混进去
    const contacts = await (await fetch(base + '/api/contacts')).json();
    assert.ok(!contacts.some((item) => item.name === '项目群'));

    // ---- 详情（按身份名）----
    const detailResponse = await fetch(base + '/api/groups/' + encoded('项目群'));
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.group.name, '项目群');
    assert.equal(detail.group.remark, '读书会');
    assert.equal(detail.group.memberCount, 3);
    assert.equal(detail.group.messages, 3);
    assert.equal(detail.members.length, 3);
    const kinds = Object.fromEntries(detail.members.map((member) => [member.name, member.kind]));
    assert.deepEqual(kinds, { 张三: 'member', 李四: 'contact', 刚子: 'member' });
    assert.equal(detail.recentMessages.length, 3);
    assert.deepEqual(detail.recentMessages.map((message) => message.content), ['几点集合', '九点', '收到']);
    assert.deepEqual(detail.recentMessages.map((message) => message.isOwner), [true, false, false]);
    assert.ok(detail.recentMessages.every((message) => message.id && message.ts));

    // ---- 详情（按真群名 remark 也能查到，且成员/消息按身份名取到）----
    const byRemark = await fetch(base + '/api/groups/' + encoded('读书会'));
    assert.equal(byRemark.status, 200);
    const remarkDetail = await byRemark.json();
    assert.equal(remarkDetail.group.name, '项目群');
    assert.equal(remarkDetail.members.length, 3);
    assert.equal(remarkDetail.recentMessages.length, 3);

    // ---- 非群 404 ----
    const contactResponse = await fetch(base + '/api/groups/' + encoded('普通联系人'));
    assert.equal(contactResponse.status, 404);
    assert.equal((await contactResponse.json()).error, '不是群聊');
    const memberResponse = await fetch(base + '/api/groups/' + encoded('张三'));
    assert.equal(memberResponse.status, 404, '群成员不是群');
    assert.equal((await memberResponse.json()).error, '不是群聊');
    const missing = await fetch(base + '/api/groups/' + encoded('查无此群'));
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, '不是群聊');
  } finally { await stopServer(server); }
});
