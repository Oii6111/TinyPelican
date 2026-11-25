'use strict';

// 群聊接口：群不是人，单独成一套接口，永远不混进 /api/contacts。
// 只读：联系人页需要「群列表 / 群成员 / 群里的最近消息」，不提供写操作。
const chatDb = require('../../memory/chat-db');

// 群详情里带最近多少条消息：够看清最近在聊什么，又不会把整个群拖进一次响应。
const RECENT_MESSAGE_LIMIT = 40;

module.exports = (router, ctx) => {
  router.get('/api/groups', (req, res) => ctx.json(res, 200, chatDb.listGroups()));

  router.get('/api/groups/:name', (req, res, c, params) => {
    const name = String(params.name || '').trim();
    const member = name ? chatDb.getMember(name) : null;
    if (!member || member.kind !== 'group') return ctx.json(res, 404, { error: '不是群聊' });
    // getMember 允许用备注（真群名）查，但成员挂靠和消息都按身份名（name）存，
    // 这里统一归一到 name，避免用 remark 查到的群取不到成员。
    const key = member.name;
    const members = chatDb.listGroupMembers(key);
    const recent = chatDb.messages(key, '', RECENT_MESSAGE_LIMIT);
    return ctx.json(res, 200, {
      group: {
        id: Number(member.id),
        name: member.name,
        remark: member.remark || '',
        kind: 'group',
        messages: Number(member.messages || 0),
        lastMessageAt: String(member.updatedAt || ''),
        memberCount: members.length
      },
      members,
      recentMessages: (recent && recent.messages) || []
    });
  });
};
