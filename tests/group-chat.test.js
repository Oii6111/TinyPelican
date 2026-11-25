// 群聊：独立实体（kind='group'）、发言人作为联系人挂靠、显示名规则、同群多批归并。
// 关注点：群消息不混进任何联系人的私聊档案；同一批人复制两次不会裂成两个群。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-group-'));
process.env.XIAOTIHU_DATA_DIR = tmp;

const chatDb = require('../core/memory/chat-db');
const { resolveBatchTarget, groupDisplayName } = require('../core/lib/chat-parser');
const { ingestMessages } = require('../core/ingest/pipeline');

const SELF = ['六壹'];
const msg = (name, ts, content) => ({ name, ts, type: 'text', content });

// ── 归属判定 ───────────────────────────────────────────────────────────
test('只有一个非自己发言人 -> 私聊，归属到对方', () => {
  const target = resolveBatchTarget([
    msg('林夏', '2026-11-12 20:14', '想去看展'),
    msg('六壹', '2026-11-12 20:15', '周六？')
  ], SELF);
  assert.strictEqual(target.kind, 'contact');
  assert.strictEqual(target.name, '林夏');
  assert.deepStrictEqual(target.members, []);
});

test('两个以上非自己发言人 -> 群聊，显示名取前三个', () => {
  const target = resolveBatchTarget([
    msg('张三', '2026-11-20 10:00', '周六爬山'),
    msg('李四', '2026-11-20 10:01', '算我一个'),
    msg('王五', '2026-11-20 10:02', '我也去'),
    msg('六壹', '2026-11-20 10:03', '几点集合')
  ], SELF);
  assert.strictEqual(target.kind, 'group');
  assert.strictEqual(target.displayName, '张三、李四、王五');
  assert.deepStrictEqual(target.members, ['张三', '李四', '王五']);
});

test('发言人超过三个时补「等 N 人」', () => {
  assert.strictEqual(groupDisplayName(['a', 'b', 'c']), 'a、b、c');
  assert.strictEqual(groupDisplayName(['a', 'b', 'c', 'd']), 'a、b、c 等 4 人');
  assert.strictEqual(groupDisplayName(['a', 'b', 'c', 'd', 'e', 'f']), 'a、b、c 等 6 人');
});

test('自己昵称没配时无法判定归属', () => {
  const target = resolveBatchTarget([msg('林夏', '2026-11-12 20:14', '嗯'), msg('六壹', '2026-11-12 20:15', '嗯')], []);
  assert.strictEqual(target.kind, 'group');
});

// ── 入库 ───────────────────────────────────────────────────────────────
test('群入库：群是 group，发言人是 contact，消息只挂在群下面', () => {
  const batch = [
    msg('张三', '2026-11-20 10:00', '周六爬山'),
    msg('李四', '2026-11-20 10:01', '算我一个'),
    msg('六壹', '2026-11-20 10:02', '我也去')
  ];
  const target = resolveBatchTarget(batch, SELF);
  const added = ingestMessages(batch, target);
  assert.strictEqual(added, 3);

  const group = chatDb.getMember(target.name);
  assert.ok(group, '群实体应该被创建');
  assert.strictEqual(group.kind, 'group');
  assert.strictEqual(group.messages, 3);

  // 群里出现过的人不会被自动加成联系人：只记成 kind='member'
  for (const name of ['张三', '李四']) {
    const speaker = chatDb.getMember(name);
    assert.strictEqual(speaker.kind, 'member', `${name} 不该被自动加为联系人`);
    assert.strictEqual(chatDb.listMembers().some(m => m.name === name && m.kind === 'contact'), false,
      `${name} 不该出现在联系人列表里`);
    // 群里的原话不能算进他和你的私聊档案
    assert.strictEqual(chatDb.contactContext(name, { limit: 5 }).recentMessages.length, 0);
  }

  // 群成员表把发言人和群挂起来
  const members = chatDb.listGroupMembers(target.name).map((item) => item.name).sort();
  assert.deepStrictEqual(members, ['张三', '李四'].sort());

  // 联系人反查群
  assert.deepStrictEqual(chatDb.listGroupsForMember('张三').map((item) => item.name), [target.name]);
});

test('同一个群换一批人复制回来：按成员重合归并，不会裂成两个群', () => {
  const batch = [
    msg('张三', '2026-11-21 09:00', '几点集合'),
    msg('李四', '2026-11-21 09:01', '九点'),
    msg('赵六', '2026-11-21 09:02', '收到'),
    msg('六壹', '2026-11-21 09:03', '我晚十分钟')
  ];
  const target = resolveBatchTarget(batch, SELF);
  assert.strictEqual(target.displayName, '张三、李四、赵六');
  ingestMessages(batch, target);

  const groups = chatDb.listMembers('').filter((member) => member.kind === 'group');
  assert.strictEqual(groups.length, 1, '同一批人应该归到已有的那个群');
  assert.strictEqual(groups[0].name, '张三、李四', '沿用先建立的群名');
  // 新出现的人也挂进来
  const names = chatDb.listGroupMembers(groups[0].name).map((item) => item.name).sort();
  assert.deepStrictEqual(names, ['张三', '李四', '赵六'].sort());
});

test('只有一个人的群聊不会被当成私聊（成员不足 2 时不新建群，交给调用方判断）', () => {
  const found = chatDb.findGroupByMembers(['张三']);
  assert.strictEqual(found, null);
});

// ── 第三方观察（画像融合的输入）────────────────────────────────────────
test('群聊观察只取他自己在群里说的话，并带上群名和上一条语境', () => {
  const observations = chatDb.groupObservationsForMember('张三', { perGroup: 5 });
  assert.strictEqual(observations.length, 1);
  assert.strictEqual(observations[0].group, '张三、李四');
  const said = observations[0].messages.map((item) => item.content);
  // 私聊里没有他的话，这里的都是群里的
  assert.ok(said.includes('周六爬山'), '应该取到他在群里说的话：' + JSON.stringify(said));
  // 李四/赵六说的不能混进「他说的话」
  assert.ok(!said.includes('算我一个'));
  assert.ok(!said.includes('收到'));
});

test('群本身没有第三方观察（群不是人）', () => {
  assert.deepStrictEqual(chatDb.groupObservationsForMember('张三、李四'), []);
});

// 注意：romance 源文件这里还有一个「画像提示词：有群聊资料时声明第三方语境」的断言，
// 它依赖 core/engine/prompts/contact-profile.js 的三参数版本（member, metrics, groupObservations）。
// 该提示词改造不在 T3（数据模型）范围内，main 上尚未移植，所以这条断言暂时留空；
// 等提示词接入后，把 romance 里那条测试原样搬回来即可（它只依赖 groupObservationsForMember 的返回结构）。

// ── 清理 ───────────────────────────────────────────────────────────────
test('purgeInbox 只删掉早期那个假联系人，不碰真实联系人和群', () => {
  chatDb.ingestMessages('inbox', [msg('某人', '2026-01-01 00:00', '旧数据')]);
  const before = chatDb.getMember('inbox');
  assert.ok(before, '先要有 inbox');

  const removed = chatDb.purgeInbox();
  assert.strictEqual(removed, 1);
  assert.strictEqual(chatDb.getMember('inbox'), null);
  assert.ok(chatDb.getMember('张三'), '真实联系人不能被误删');
});

// ── 备注与身份分开 ─────────────────────────────────────────────────────
test('真群名进备注：界面显示用 remark，身份仍是按发言人拼的名字', () => {
  const batch = [msg('甲', '2026-12-01 09:00', 'a'), msg('乙', '2026-12-01 09:01', 'b')];
  const target = resolveBatchTarget(batch, SELF, { session: { name: '读书会', kind: 'group', memberCount: 12 } });
  assert.strictEqual(target.remark, '读书会');
  ingestMessages(batch, target);

  const group = chatDb.listGroups().find(item => item.remark === '读书会');
  assert.ok(group, '群应该按 remark 能查到');
  assert.strictEqual(group.name, '甲、乙', '身份名仍按发言人拼');
  assert.notStrictEqual(group.name, group.remark);
  assert.strictEqual(group.remark, '读书会');
});

test('真群名相同、发言人全换了，仍然归到同一个群', () => {
  const before = chatDb.listGroups().filter(item => item.remark === '读书会').length;
  const batch = [msg('丙', '2026-12-02 09:00', 'c'), msg('丁', '2026-12-02 09:01', 'd')];
  const target = resolveBatchTarget(batch, SELF, { session: { name: '读书会', kind: 'group', memberCount: 12 } });
  ingestMessages(batch, target);
  const after = chatDb.listGroups().filter(item => item.remark === '读书会').length;
  assert.strictEqual(after, before, '真群名是更可靠的归并键，不该裂成两个群');
});

test('群名和某个联系人重名时，不会把联系人接管成群', () => {
  chatDb.ingestMessages('阿杰', [msg('阿杰', '2026-11-22 10:00', '私聊一句')]);
  assert.strictEqual(chatDb.getMember('阿杰').kind, 'contact');

  const batch = [msg('阿杰', '2026-11-22 11:00', '群里说一句'), msg('六壹', '2026-11-22 11:01', '嗯')];
  const target = resolveBatchTarget(batch, SELF, { session: { name: '阿杰的小群', kind: 'group', memberCount: 5 } });
  ingestMessages(batch, target);

  assert.strictEqual(chatDb.getMember('阿杰').kind, 'contact', '联系人不能被群接管');
  assert.strictEqual(chatDb.contactContext('阿杰', { limit: 5 }).recentMessages.length, 1, '私聊那条还在');
  const group = chatDb.listGroups().find(item => item.remark === '阿杰的小群');
  assert.ok(group, '群应该被建出来');
  assert.strictEqual(group.messages, 2);
});

// ── 备注链路（回归：曾经在 normalizeTarget 里丢掉 remark，备注永远写不进去）────
test('normalizeTarget 不能把 remark 丢掉', () => {
  const { normalizeTarget } = require('../core/ingest/pipeline');
  const target = normalizeTarget({ kind: 'contact', name: 'Baby', displayName: '小宝贝', remark: '小宝贝', members: [] });
  assert.strictEqual(target.remark, '小宝贝', 'remark 丢失会让截图读到的名字永远写不进备注');
  assert.strictEqual(target.name, 'Baby', '身份名不受影响');
  // 老调用方只给字符串时不该凭空造备注
  assert.strictEqual(normalizeTarget('Baby').remark, '');
});

test('带 remark 入库会写进备注；已经有的备注不被覆盖', () => {
  const first = [msg('小明', '2026-12-05 10:00', '你好')];
  ingestMessages(first, { kind: 'contact', name: '小明', displayName: '小明备注', remark: '小明备注', members: [] });
  assert.strictEqual(chatDb.getMember('小明').remark, '小明备注');

  // 再来一次，remark 换了一个：不该把用户可能在界面上手改过的备注覆盖掉
  const second = [msg('小明', '2026-12-05 10:01', '在吗')];
  ingestMessages(second, { kind: 'contact', name: '小明', displayName: '别的名字', remark: '别的名字', members: [] });
  assert.strictEqual(chatDb.getMember('小明').remark, '小明备注');
});

test('群也会把截图读到的真群名写进备注', () => {
  const batch = [msg('甲', '2026-12-06 09:00', 'x'), msg('乙', '2026-12-06 09:01', 'y')];
  ingestMessages(batch, { kind: 'group', name: '甲、乙', displayName: '读书会', remark: '读书会', members: ['甲', '乙'] });
  const group = chatDb.listGroups().find(item => item.remark === '读书会');
  assert.ok(group, '群的备注应该写上');
});

test('群里的陌生人不会被自动加成联系人；加了他才出现', () => {
  const batch = [msg('老王', '2026-12-08 09:00', 'x'), msg('小赵', '2026-12-08 09:01', 'y')];
  ingestMessages(batch, { kind: 'group', name: '老王、小赵', displayName: '项目群', remark: '项目群', members: ['老王', '小赵'] });

  // 不在联系人列表里
  const contacts = chatDb.listMembers().filter(item => item.kind === 'contact').map(item => item.name);
  assert.strictEqual(contacts.includes('老王'), false, '群里的陌生人不能自动进联系人');
  assert.strictEqual(chatDb.getMember('老王').kind, 'member');
  // 但群成员列表里看得到
  assert.deepStrictEqual(chatDb.listGroupMembers('老王、小赵').map(item => item.name).sort(), ['小赵', '老王'].sort());
  assert.deepStrictEqual(chatDb.listGroupMembers('老王、小赵').map(item => item.kind).sort(), ['member', 'member']);

  // 用户主动加
  const promoted = chatDb.promoteContact('老王');
  assert.strictEqual(promoted.kind, 'contact');
  assert.strictEqual(chatDb.listMembers().some(item => item.name === '老王' && item.kind === 'contact'), true);
  // 另一个没加的仍然是 member
  assert.strictEqual(chatDb.getMember('小赵').kind, 'member');
});

test('群里见过的人后来直接私聊了，会自动升级成联系人', () => {
  const batch = [msg('阿明', '2026-12-09 09:00', 'z'), msg('六壹', '2026-12-09 09:01', 'w')];
  ingestMessages(batch, { kind: 'group', name: '小群', displayName: '小群', remark: '小群', members: ['阿明'] });
  assert.strictEqual(chatDb.getMember('阿明').kind, 'member');

  // 后来一对一聊了一次
  ingestMessages([msg('阿明', '2026-12-10 10:00', '私聊一句')], { kind: 'contact', name: '阿明', displayName: '阿明', remark: '', members: [] });
  assert.strictEqual(chatDb.getMember('阿明').kind, 'contact', '有过私聊就该升级成联系人');
});


// ── 老库兼容（回归：升级不能把已有数据判错）──────────────────────────────
test('老库行：member.kind 默认 contact，is_owner 为 NULL 时退回按 sender 名字判定', () => {
  const now = new Date().toISOString();
  // 老版本建的行没有 kind：insert 不带这一列，必须由 DEFAULT 'contact' 兜住
  chatDb.db.prepare('INSERT OR IGNORE INTO member(platform_id,name,created_at,updated_at) VALUES(?,?,?,?)')
    .run('老库某人', '老库某人', now, now);
  assert.strictEqual(chatDb.getMember('老库某人').kind, 'contact', '老行要算联系人');
  assert.strictEqual(chatDb.listMembers('老库某人')[0].kind, 'contact');

  // 老消息的 is_owner 是 NULL：判定必须退回「按 sender 名字」，不能一律算本人/联系人
  const ts = '2026-01-01 10:00:00';
  chatDb.db.prepare('INSERT OR IGNORE INTO message(member_id,sender,ts,type,content,content_hash,ts_ms) VALUES(?,?,?,?,?,?,?)')
    .run(chatDb.getMember('老库某人').id, '老库某人', ts, 'text', '老消息', 'legacy-hash-1', Date.parse(ts));
  const message = chatDb.messages('老库某人', '', 10, false).messages.find((item) => item.content === '老消息');
  assert.strictEqual(message.isOwner, false, 'sender 是联系人名 -> 对方');
  assert.strictEqual(message.speakerRole, '联系人');
  assert.strictEqual(Object.hasOwn(message, 'is_owner'), false, '对外的 isOwner 由 is_owner 派生，不再漏原始列');
});

test('冷库老文件：首读自动补 ts_ms/source/is_owner，老行按名字判定且能挡住重复导入', () => {
  const { DatabaseSync } = require('node:sqlite');
  const archive = require('../core/memory/archive');
  const coldPath = archive.archivePath('冷库老联系人');
  // 先有联系人本身：archiveMessages 要靠 member 行解析说话人
  chatDb.ingestMessages('冷库老联系人', [msg('冷库老联系人', new Date().toISOString(), '热的那条')]);
  // 手工造一个旧格式冷库：没有 ts_ms / source / is_owner
  fs.mkdirSync(path.dirname(coldPath), { recursive: true });
  const cold = new DatabaseSync(coldPath);
  cold.exec(`CREATE TABLE message (id INTEGER PRIMARY KEY, sender TEXT NOT NULL, ts TEXT NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT UNIQUE);
    INSERT INTO message(id,sender,ts,type,content,content_hash) VALUES(1,'冷库老联系人','2026-01-01 08:00:00','text','冷库里的话','cold-hash-1');
    INSERT INTO message(id,sender,ts,type,content,content_hash) VALUES(2,'我','2026-01-01 08:01:00','text','我说的话','cold-hash-2');`);
  cold.close();

  const page = chatDb.archiveMessages('冷库老联系人', '', 10);
  const other = page.messages.find((item) => item.content === '冷库里的话');
  const mine = page.messages.find((item) => item.content === '我说的话');
  assert.ok(other && mine, '老冷库里的消息应该读得出来');
  assert.strictEqual(other.isOwner, false, 'is_owner 为 NULL -> 按 sender 名字回退');
  assert.strictEqual(mine.isOwner, true);

  // 回填过的 ts_ms 才让 (ts_ms,id) 游标有意义
  const verify = new DatabaseSync(coldPath);
  const row = verify.prepare("SELECT ts_ms FROM message WHERE content='冷库里的话'").get();
  verify.close();
  assert.ok(row.ts_ms > 0, 'ts_ms 必须被一次性回填');

  // 老冷库去重：同一条再导一次不能算新增（source 为空的老行仍要命中）
  assert.strictEqual(chatDb.ingestMessages('冷库老联系人', [msg('冷库老联系人', '2026-01-01 08:00:00', '冷库里的话')]), 0);
});

test('迁移幂等：同一个库第二次启动（模块重新加载）不报错、不重复加列', () => {
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-idempotent-'));
  const entry = path.join(__dirname, '..', 'core', 'memory', 'chat-db.js');
  const script = [
    `const chat = require(${JSON.stringify(entry)});`,
    "const cols = chat.db.prepare('PRAGMA table_info(message)').all().map((c) => c.name);",
    "const mcols = chat.db.prepare('PRAGMA table_info(member)').all().map((c) => c.name);",
    "if (new Set(cols).size !== cols.length) throw new Error('message 列重复: ' + cols.join(','));",
    "if (new Set(mcols).size !== mcols.length) throw new Error('member 列重复: ' + mcols.join(','));",
    "if (!chat.db.prepare(\"SELECT 1 FROM sqlite_master WHERE name='member_group_link'\").get()) throw new Error('member_group_link 没建出来');",
    "chat.db.close(); process.stdout.write('ok');"
  ].join('\n');
  try {
    // 第 1 次建库并迁移；第 2 次是「已经迁移过的库」，必须什么都不做也不报错
    for (let i = 0; i < 2; i += 1) {
      const out = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, XIAOTIHU_DATA_DIR: dir }, encoding: 'utf8' });
      assert.strictEqual(out, 'ok', `第 ${i + 1} 次加载失败`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('导入来源约定：source/platform_message_id 落库，externalId 重导不重复（T5 导入依赖这条）', () => {
  const external = (n) => JSON.stringify(['rec-1', 'sig', n]);
  const rows = [
    { name: '我', ts: '2026-02-01 10:00:00', content: '我说', source: 'aiworks', isOwner: true, externalId: external(0) },
    { name: '小雨2', ts: '2026-02-01 10:00:01', content: '对方说', source: 'aiworks', isOwner: false, externalId: external(1) }
  ];
  assert.strictEqual(chatDb.ingestMessages('导入联系人', rows), 2);
  const stored = chatDb.db.prepare('SELECT source,is_owner,platform_message_id,ts_ms FROM message WHERE member_id=? ORDER BY ts_ms')
    .all(chatDb.getMember('导入联系人').id);
  assert.deepStrictEqual(stored.map((row) => [row.source, row.is_owner, row.platform_message_id]),
    [['aiworks', 1, external(0)], ['aiworks', 0, external(1)]]);
  assert.ok(stored.every((row) => row.ts_ms > 0), 'ts_ms 必须落值');
  // 同一份笔记再导一次：externalId 是幂等键
  assert.strictEqual(chatDb.ingestMessages('导入联系人', rows), 0);
  // 说话人按 is_owner 判定，不再依赖 sender 名字
  const identities = chatDb.messages('导入联系人', '', 10).messages.map((item) => [item.sender, item.isOwner, item.source]);
  assert.deepStrictEqual(identities, [['我', true, 'aiworks'], ['小雨2', false, 'aiworks']]);
});

test('联系人接口：群和群成员不出现在 /api/contacts 的返回里', () => {
  let handler = null;
  const router = { get(route, fn) { if (route === '/api/contacts') handler = fn; }, post() {}, delete() {}, put() {} };
  require('../core/api/routes/contacts')(router, { json(res, status, body) { res.answer = { status, body }; } });
  assert.ok(handler, '应该注册了 /api/contacts');
  const res = {};
  handler({}, res, null, null, new URL('http://127.0.0.1/api/contacts'));
  const names = res.answer.body.map((item) => item.name);
  assert.strictEqual(res.answer.status, 200);
  assert.ok(names.includes('老库某人'), '联系人应该返回');
  assert.strictEqual(names.includes('张三、李四'), false, '群不该出现在联系人接口');
  assert.strictEqual(names.includes('张三'), false, '群成员（kind=member）也不该出现');
});

// ── 采集链路：群身份要一路透传到入库与展示 ────────────────────────────
// 采集侧算出 batch.target 只是第一步；onBatch 不消费它的话，群消息仍会按联系人入库、
// 通知里还会把群名写成「联系人」。这里锁两件事：describeTarget 的展示口径，
// 以及 index.js 的 onBatch 确实把 target 传给了入库函数。
test('describeTarget：群聊不叫联系人，老调用方传字符串时按私聊处理', () => {
  const { describeTarget } = require('../core/ingest/pipeline');
  const group = describeTarget({ kind: 'group', name: '张三、李四', displayName: '项目群', remark: '项目群', members: ['张三', '李四'] });
  assert.strictEqual(group.isGroup, true);
  assert.strictEqual(group.label, '群聊');
  assert.strictEqual(group.name, '张三、李四');
  assert.strictEqual(group.remark, '项目群');

  const contact = describeTarget({ kind: 'contact', name: '张三' });
  assert.strictEqual(contact.isGroup, false);
  assert.strictEqual(contact.label, '联系人');

  const legacy = describeTarget('张三');
  assert.strictEqual(legacy.isGroup, false, '老调用方只给字符串时不能被当成群');
  assert.strictEqual(legacy.name, '张三');
  assert.strictEqual(describeTarget('').kind, 'contact');
});

test('index.js 的 onBatch 把 batch.target 传给入库，而不是只传联系人字符串', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'index.js'), 'utf8');
  assert.match(source, /onBatch:\s*\(\{[^}]*\btarget\b/, 'onBatch 必须解构出 target');
  assert.match(source, /ingestCapturedBatch\(msgs,\s*target\s*\|\|\s*contact/, '带附件归档要传 target');
  assert.match(source, /ingestMessages\(msgs,\s*target\s*\|\|\s*contact/, '纯文本归档要传 target');
  assert.match(source, /describeTarget\(/, '展示口径统一走 describeTarget');
});

// ── 未移植的断言（main 没有对应模块）──────────────────────────────────────
// romance 源文件结尾还有 3 条测试：「群不能建关系档案」「关系接口拒绝群」「历史群关系也进不了情感大师」。
// 它们依赖 core/memory/stores/romance-relationships 与 core/api/routes/romance；
// 按本次迁移的约束，main 不引入 romance 存储/画像/教练，所以整段不移植。
// 将来 main 真有关系档案时，再连同存储层对 kind='group' 的拦截一起补回来。
