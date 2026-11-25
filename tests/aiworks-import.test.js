// 思必驰（AIWorks）云笔记导入：转写切段、说话人身份映射、路由鉴权/同源校验、externalId 去重
// 全程用注入的假 fetch / 假 token store，不访问 aiworks.cn。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { transcript, toMessages } = require('../core/import/aiworks');

test('转写切段：云端格式只认「说话人/发言人」标签，粘贴格式接受任意「名字：」', () => {
  const cloud = transcript('00:00:01 说话人1: 我到门口了\n00:00:04 说话人2: 我下来接你\n无标签的补充');
  assert.deepEqual(cloud, [
    { speaker: '说话人1', time: '00:00:01', text: '我到门口了' },
    { speaker: '说话人2', time: '00:00:04', text: '我下来接你\n无标签的补充' }
  ]);
  const pasted = transcript('我：今天见面很开心\n对方：我也是', { pasted: true });
  assert.deepEqual(pasted.map(segment => [segment.speaker, segment.text]), [['我', '今天见面很开心'], ['对方', '我也是']]);
  assert.throws(() => transcript(''), /暂无转写/);
});

test('说话人身份映射成消息：self/contact/skip，externalId 稳定且与开始时间无关', () => {
  const segments = [
    { speaker: 'A', time: '00:00:01', text: '我到门口了' },
    { speaker: 'B', time: '00:00:04', text: '我下来接你' },
    { speaker: 'C', time: '00:00:05', text: '旁人的发言' }
  ];
  const roles = { A: 'self', B: 'contact', C: 'skip' };
  const first = toMessages(segments, roles, '小雨', '2025-10-01T02:00:00.000Z', 'note:test-note');
  assert.deepEqual(first.map(message => [message.name, message.isOwner, message.source, message.ts, message.content]), [
    ['我', true, 'aiworks', '2025-10-01T02:00:01.000Z', '我到门口了'],
    ['小雨', false, 'aiworks', '2025-10-01T02:00:04.000Z', '我下来接你']
  ]);
  const later = toMessages(segments, roles, '小雨', '2025-10-02T02:00:00.000Z', 'note:test-note');
  assert.deepEqual(later.map(message => message.externalId), first.map(message => message.externalId), '开始时间变了，externalId 仍应稳定');
  assert.notEqual(later[0].ts, first[0].ts);
  assert.throws(() => toMessages(segments, { A: 'self' }, '小雨', '2025-10-01T02:00:00.000Z', 'note:test-note'), /请确认每位说话人的身份/);
  assert.throws(() => toMessages(segments, { A: 'self', B: 'contact', C: 'skip' }, '小雨', '不是时间', 'note:x'), /开始时间/);
});

test('录制笔记导入：列表/预览/确认入库/重复导入去重/转写版本冲突/粘贴转写', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tinypelican-aiworks-'));
  process.env.XIAOTIHU_DATA_DIR = directory;
  const chatDb = require('../core/memory/chat-db');
  let token = '';
  let asrContent = '00:00:01 说话人1: 我到门口了\r\n00:00:04 说话人2: 我下来接你\r\n00:00:05 说话人3: 旁人的发言';
  const { createAiworks } = require('../core/import/aiworks');
  const { createRouter } = require('../core/api/router');
  const aiworks = createAiworks({
    tokens: {
      read: async () => token,
      save: async value => { token = value; },
      clear: async () => { token = ''; },
      persistent: false
    },
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).origin, 'https://aiworks.cn');
      assert.equal(options.headers.Authorization, 'Bearer sample-token');
      assert.equal(options.redirect, 'error');
      const data = url.includes('/note/list?')
        ? { list: [{ noteUid: 'test-note', title: '见面', createTime: '2025-10-01 10:00:00' }], total: 1 }
        : { asrContent, title: '见面', createTime: '2025-10-01 10:00:00' };
      return Response.json({ code: '0', data });
    }
  });
  const router = createRouter();
  require('../core/api/routes/aiworks')(router, {
    readBody: async req => JSON.stringify(req.body),
    json(res, status, body) { Object.assign(res, { status, body }); }
  }, { aiworks, chatDb });
  const call = async (method, suffix, body, origin = 'http://127.0.0.1:18791') => {
    const response = { setHeader() {} };
    const req = { method, url: '/api/import/aiworks' + suffix, body,
      headers: { host: '127.0.0.1:18791', origin, 'content-type': 'application/json' } };
    assert.equal(await router.match(req, response), true);
    return response;
  };
  try {
    // 同源校验发生在任何云端请求之前。
    assert.equal((await call('POST', '/connect', { token: 'sample-token' }, 'https://example.com')).status, 403);
    assert.equal((await call('POST', '/connect', { token: 'sample-token' })).body.connected, true);
    assert.equal(JSON.stringify((await call('GET', '')).body).includes('sample-token'), false, '状态里不能回传授权码');
    assert.equal((await call('GET', '/notes')).body.notes[0].uid, 'test-note');
    assert.equal((await call('GET', '/notes?page=0')).status, 400);
    const preview = (await call('GET', '/notes/test-note')).body;
    assert.equal(preview.createdAt, '2025-10-01T02:00:00.000Z');
    assert.deepEqual(preview.segments.map(segment => segment.speaker), ['说话人1', '说话人2', '说话人3']);
    const input = { uid: preview.uid, version: preview.version, contact: '小雨', startedAt: preview.createdAt,
      roles: { 说话人1: 'self', 说话人2: 'contact', 说话人3: 'skip' } };

    assert.equal((await call('POST', '/commit', { ...input, roles: {} })).status, 400);
    assert.equal(chatDb.getMember('小雨'), null);
    // 先放一条 3 秒后的微信消息，验证录音消息按时间插进正确位置。
    const local = new Date('2025-10-01T02:00:03.000Z');
    const pad = value => String(value).padStart(2, '0');
    const localTs = `${local.getFullYear()}-${local.getMonth() + 1}-${local.getDate()} ${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`;
    chatDb.ingestMessages('小雨', [{ name: '小雨', ts: localTs, content: '微信：已经到了吗' }]);
    assert.equal((await call('POST', '/commit', input)).body.added, 2);
    assert.equal((await call('POST', '/commit', input)).body.added, 0, '完全相同的确认不应重复入库');
    assert.equal((await call('POST', '/commit', { ...input, startedAt: '2025-10-01T03:00:00.000Z' })).body.added, 0,
      '开始时间被调整后，仍应按 externalId 去重（不是按时间+内容哈希）');
    const expected = [
      ['我', true, 'aiworks', '2025-10-01T02:00:01.000Z', '我到门口了'],
      ['小雨', false, undefined, localTs, '微信：已经到了吗'],
      ['小雨', false, 'aiworks', '2025-10-01T02:00:04.000Z', '我下来接你']
    ];
    const project = messages => messages.map(message => [message.sender, message.isOwner, message.source, message.ts, message.content]);
    assert.deepEqual(project(chatDb.messages('小雨').messages), expected);
    const latest = chatDb.messages('小雨', '', 2).messages;
    assert.deepEqual(project(latest), expected.slice(1));
    assert.deepEqual(project(chatDb.messages('小雨', '', 2, false, latest[0].ts, latest[0].id).messages), expected.slice(0, 1));
    const archive = require('../core/memory/archive');
    chatDb.archiveExpired('小雨');
    const oldArchive = new (require('node:sqlite').DatabaseSync)(archive.archivePath('小雨'));
    try { oldArchive.exec('DROP INDEX idx_message_time; ALTER TABLE message DROP COLUMN ts_ms'); }
    finally { oldArchive.close(); }
    assert.equal(archive.stats('小雨').total, 3, '冷库缺 ts_ms 时应能懒迁移回填');
    assert.deepEqual(project(chatDb.archiveMessages('小雨').messages), expected);
    const archived = chatDb.archiveMessages('小雨', '', 2).messages;
    assert.deepEqual(project(chatDb.archiveMessages('小雨', archived[0].ts, 2, archived[0].id).messages), expected.slice(0, 1));
    assert.equal((await call('POST', '/commit', input)).body.added, 0, '归档后的消息也不应被重复导入');

    // 云端转写追加了一句：旧版本号拒绝，重新预览后只补新增的那句。
    asrContent += '\n00:00:07 说话人2: 走吧';
    assert.equal((await call('POST', '/commit', input)).status, 409);
    const refreshed = (await call('GET', '/notes/test-note')).body;
    assert.equal((await call('POST', '/commit', { ...input, version: refreshed.version })).body.added, 1);
    assert.equal((await call('POST', '/disconnect', {})).body.connected, false);
    assert.equal((await call('GET', '/notes')).status, 422);
    const text = '我：今天见面很开心\n对方：我也是';
    const pasted = await call('POST', '/preview-text', { text });
    assert.deepEqual(pasted.body.segments.map(segment => segment.speaker), ['我', '对方']);
    assert.equal((await call('POST', '/commit', { text, contact: '小雨', startedAt: preview.createdAt,
      roles: { 我: 'self', 对方: 'contact' } })).body.added, 2);
  } finally {
    chatDb.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
