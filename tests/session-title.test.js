// 会话名读取（截窗口标题条 + 视觉模型）与它在归属判定里的作用。
// 关注点：只在微信窗口 + 显式开启时才动；任何失败都退回按发言人推断，绝不挡住入库。
//
// 这个测试文件不直接依赖 core/lib/chat-parser 的 resolveBatchTarget：
// 归属判定在 clipboard.js 里有一个「优先上游、缺失本地兜底」的接缝，
// 这里统一通过 ClipboardWatcher 的交付链路验证行为，T3 合入前后都能跑。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-title-'));
process.env.XIAOTIHU_DATA_DIR = tmp;

const { parseTitleJson, normalizeTitle, captureStrip, readTitleFromBytes } = require('../core/capture/session-title');
const { ClipboardWatcher } = require('../core/capture/clipboard');

const SELF = ['六壹'];
const msg = (name, ts, content) => ({ name, ts, type: 'text', content });
const WIN = {
  handle: '123',
  pid: '9',
  processName: 'WeChat',
  bounds: { left: 0, top: 0, right: 800, bottom: 600 },
  dpi: 96
};
// 块格式：昵称 / 时间 / 内容，消息之间空行分隔
const chatOf = (...pairs) => pairs
  .map(([name, ts, content]) => [name, ts, content].join('\n'))
  .join('\n\n');
const TS_ZHANG = '2026年11月20日 10:00';
const TS_LIN = '2026年11月12日 20:14';

// ── 视觉模型输出解析 ───────────────────────────────────────────────────
test('会话名 JSON：正常、带代码块、乱码三种输入', () => {
  assert.deepStrictEqual(parseTitleJson('{"name":"周末爬山群","kind":"group","memberCount":23}'),
    { name: '周末爬山群', kind: 'group', memberCount: 23 });
  assert.deepStrictEqual(parseTitleJson('```json\n{"name":"林夏","kind":"contact","memberCount":0}\n```'),
    { name: '林夏', kind: 'contact', memberCount: 0 });
  assert.strictEqual(parseTitleJson('我看不出来'), null);
  assert.strictEqual(parseTitleJson('{"name":"","kind":"unknown","memberCount":0}'), null, '空名字要当成没读到');
});

test('name 长度截断、memberCount 容错', () => {
  const long = normalizeTitle({ name: 'x'.repeat(200), kind: 'group', memberCount: 'abc' });
  assert.strictEqual(long.name.length, 80);
  assert.strictEqual(long.memberCount, 0);
  assert.strictEqual(normalizeTitle({ name: '林夏', kind: '奇怪的类型' }).kind, 'contact');
});

test('没配置视觉模型 / 空截图 / 无窗口句柄时都不发请求，直接返回 null', async () => {
  // 空截图：连 visionTarget 都不进
  assert.strictEqual(await readTitleFromBytes(null, {}), null);
  assert.strictEqual(await readTitleFromBytes(Buffer.alloc(0), {}), null);
  // 配置里没有视觉模型：visionTarget 不 ok，返回 null（不会走到 chatCompletion）
  assert.strictEqual(await readTitleFromBytes(Buffer.from('fake-png'), {}), null);
  // 无效句柄：不起 PowerShell 截屏
  assert.strictEqual(await captureStrip(0), null);
  assert.strictEqual(await captureStrip('not-a-number'), null);
});

// ── Watcher 的调用条件 ──────────────────────────────────────────────────
// 截图一律用假的：测试里不该真的去截屏或调模型
const fakeStrip = async () => Buffer.from('fake-png-bytes');
function makeWatcher(config, reader) {
  return new ClipboardWatcher({ onBatch: () => {}, config, sessionReader: reader, stripCapture: fakeStrip });
}

test('只有「微信窗口 + 开关打开 + 有句柄」三个条件都满足才去读会话名', async () => {
  let calls = 0;
  const reader = async () => { calls++; return { name: '林夏', kind: 'contact', memberCount: 0 }; };
  const on = makeWatcher({ pollMs: 1, selfNicknames: SELF, capture: { readSessionTitle: true } }, reader);

  assert.deepStrictEqual(await on._readSession({ handle: '123', processName: 'Weixin' }),
    { name: '林夏', kind: 'contact', memberCount: 0 });
  assert.strictEqual(calls, 1);

  // 非微信窗口：不该截图
  assert.strictEqual(await on._readSession({ handle: '123', processName: 'chrome' }), null);
  // 没有句柄
  assert.strictEqual(await on._readSession({ processName: 'Weixin' }), null);
  // 开关没开（老配置里没有这个键）
  const off = makeWatcher({ pollMs: 1, selfNicknames: SELF, capture: {} }, reader);
  assert.strictEqual(await off._readSession({ handle: '123', processName: 'Weixin' }), null);
  assert.strictEqual(calls, 1, '开关关着就不该调用视觉模型');

  // 显式注入 false：彻底关掉
  const disabled = new ClipboardWatcher({ onBatch: () => {}, config: { pollMs: 1, selfNicknames: SELF, capture: { readSessionTitle: true } }, sessionReader: false, stripCapture: fakeStrip });
  assert.strictEqual(await disabled._readSession({ handle: '123', processName: 'Weixin' }), null);
});

test('读取失败不影响入库：异常被吞掉，返回 null', async () => {
  const broken = makeWatcher({ pollMs: 1, selfNicknames: SELF, capture: { readSessionTitle: true } },
    async () => { throw new Error('模型挂了'); });
  assert.strictEqual(await broken._readSession({ handle: '123', processName: 'Weixin' }), null);
});

test('读不到会话名时重截一次：复制那一刻可能刚好被盖住', async () => {
  let captures = 0;
  let reads = 0;
  const watcher = new ClipboardWatcher({
    onBatch: () => {},
    config: { pollMs: 1, selfNicknames: SELF, capture: { readSessionTitle: true } },
    stripCapture: async () => { captures += 1; return Buffer.from('strip'); },
    // 第一次没读到，第二次读到
    sessionReader: async () => { reads += 1; return reads === 1 ? null : { name: '林夏', kind: 'contact', memberCount: 0 }; }
  });
  watcher.running = true;
  const session = await watcher._readSession({ handle: '123', processName: 'Weixin' });
  assert.deepStrictEqual(session, { name: '林夏', kind: 'contact', memberCount: 0 });
  assert.equal(captures, 2, '第一次没读到应该重新截一次');
  assert.equal(reads, 2);
});

test('两次都读不到就老老实实返回 null，不重试第三次', async () => {
  let captures = 0;
  const watcher = new ClipboardWatcher({
    onBatch: () => {},
    config: { pollMs: 1, selfNicknames: SELF, capture: { readSessionTitle: true } },
    stripCapture: async () => { captures += 1; return Buffer.from('strip'); },
    sessionReader: async () => null
  });
  watcher.running = true;
  assert.strictEqual(await watcher._readSession({ handle: '123', processName: 'Weixin' }), null);
  assert.equal(captures, 2);
});

// ── 归属判定：会话名优先（走完整交付链路）───────────────────────────────
// 通过 _handleClip → 防抖队列 → _flushBatches 交付，断言 onBatch 收到的 target。
// 这样既验证接线，又不依赖 chat-parser 是否已经导出 resolveBatchTarget。
function makeDeliveryWatcher(session) {
  const batches = [];
  const watcher = new ClipboardWatcher({
    onBatch: (batch) => batches.push(batch),
    config: { pollMs: 1, selfNicknames: SELF, capture: { enabled: true, readSessionTitle: true } },
    stripCapture: fakeStrip,
    sessionReader: async () => session
  });
  watcher.running = true;
  return { watcher, batches };
}

test('窗口说是群聊：一段只有一个发言人的群聊也不会被误判成私聊', async () => {
  const { watcher, batches } = makeDeliveryWatcher({ name: '周末爬山群', kind: 'group', memberCount: 23 });
  watcher._handleClip(chatOf(['张三', TS_ZHANG, '周六爬山'], ['六壹', '2026年11月20日 10:02', '我也去']), WIN);
  await watcher._flushBatches();

  assert.strictEqual(batches.length, 1);
  const target = batches[0].target;
  assert.strictEqual(target.kind, 'group', '窗口说是群，就不能按单发言人判成私聊');
  // 截图读到的真群名进 remark；name 仍按发言人拼（身份用）
  assert.strictEqual(target.remark, '周末爬山群');
  assert.strictEqual(target.name, '张三');
  assert.strictEqual(target.memberCount, 23);
  assert.strictEqual(target.source, 'window');
  assert.deepStrictEqual(target.members, ['张三'], '成员只记本批真的说过话的人');
  assert.strictEqual(batches[0].contact, '', '群聊不落成某个联系人的私聊');
});

test('窗口说是私聊：名字仍然用剪贴板里原文的那个人', async () => {
  const { watcher, batches } = makeDeliveryWatcher({ name: '林夏（备注）', kind: 'contact', memberCount: 0 });
  watcher._handleClip(chatOf(['林夏', TS_LIN, '想去看展'], ['六壹', '2026年11月12日 20:15', '周六？']), WIN);
  await watcher._flushBatches();

  assert.strictEqual(batches.length, 1);
  const target = batches[0].target;
  assert.strictEqual(target.kind, 'contact');
  assert.strictEqual(target.name, '林夏', '标题可能被截断或套了备注名，以消息原文为准');
  assert.strictEqual(target.remark, '林夏（备注）', '截图读到的显示名进备注');
  assert.strictEqual(target.source, 'window');
  assert.strictEqual(batches[0].contact, '林夏');
});

test('窗口没读出来时保持原来的启发式', async () => {
  const single = makeDeliveryWatcher(null);
  single.watcher._handleClip(chatOf(['张三', TS_ZHANG, '周六爬山']), WIN);
  await single.watcher._flushBatches();
  assert.strictEqual(single.batches.length, 1);
  assert.strictEqual(single.batches[0].target.kind, 'contact');
  assert.strictEqual(single.batches[0].target.source, 'speakers');
  assert.strictEqual(single.batches[0].contact, '张三');

  const group = makeDeliveryWatcher(null);
  group.watcher._handleClip(chatOf(
    ['张三', TS_ZHANG, '周六爬山'],
    ['李四', '2026年11月20日 10:01', '算我']
  ), WIN);
  await group.watcher._flushBatches();
  assert.strictEqual(group.batches.length, 1);
  assert.strictEqual(group.batches[0].target.kind, 'group');
  assert.strictEqual(group.batches[0].target.source, 'speakers');
  assert.strictEqual(group.batches[0].contact, '');
});
