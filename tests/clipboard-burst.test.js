// 连续复制：只要剪贴板内容符合微信聊天记录的格式，每一次复制都必须入库。
// 回归点：
//  - 250ms 防抖窗口内连着复制两段不同聊天，两批都要交给上层（旧实现用「覆盖定时器」，
//    前一秕的新消息会被丢掉，而且它们已经在 seen 集合里，等于永久丢失）；
//  - 队列按复制顺序交付，联系人归属各自算，不会混成一条；
//  - 停止监听时，已排队还没交付的批次要先落库，不能丢。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-capture-burst-'));
process.env.XIAOTIHU_DATA_DIR = tmp;

const { ClipboardWatcher } = require('../core/capture/clipboard');
const chatDb = require('../core/memory/chat-db');
const { ingestMessages } = require('../core/ingest/pipeline');

const WIN = {
  handle: '123',
  pid: '9',
  processName: 'WeChat',
  bounds: { left: 0, top: 0, right: 800, bottom: 600 },
  dpi: 96
};

const HANK = ['Hank', '2026年9月15日 21:30', '明天下午三点开会'].join('\n');
const LUO = ['罗卜头', '2026年9月15日 21:32', '文件我晚点发你'].join('\n');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 和 core/index.js 的 onBatch 一样：先入库，再记批次
function makeWatcher() {
  const batches = [];
  let added = 0;
  const watcher = new ClipboardWatcher({
    onBatch: (batch) => {
      batches.push(batch);
      added += ingestMessages(batch.msgs, batch.contact);
    },
    config: { selfNicknames: ['我'], capture: { enabled: true }, pollMs: 700, minMatchLines: 2 }
  });
  return { watcher, batches, totalAdded: () => added };
}

test('250ms 内连续复制两段不同聊天：两批都入库，归属各自正确', async () => {
  const { watcher, batches, totalAdded } = makeWatcher();
  watcher._handleClip(HANK, WIN);
  watcher._handleClip(LUO, WIN); // 同一个 tick 里的第二次复制
  await sleep(400);
  watcher.stop();

  assert.strictEqual(batches.length, 2, '两次复制应各交付一批');
  assert.deepStrictEqual(batches.map((b) => b.contact), ['Hank', '罗卜头']);
  assert.deepStrictEqual(batches.map((b) => b.msgs.map((m) => m.content)), [['明天下午三点开会'], ['文件我晚点发你']]);
  assert.strictEqual(totalAdded(), 2, '两条消息都要真正落库');
  assert.strictEqual(chatDb.messages('Hank', '', 10).messages.length, 1);
  assert.strictEqual(chatDb.messages('罗卜头', '', 10).messages.length, 1);
});

test('连续复制同一联系人三段不同内容：全部入库，顺序不乱', async () => {
  const { watcher, batches, totalAdded } = makeWatcher();
  const texts = [
    ['Hank', '2026年9月16日 09:00', '第一条'].join('\n'),
    ['Hank', '2026年9月16日 09:01', '第二条'].join('\n'),
    ['Hank', '2026年9月16日 09:02', '第三条'].join('\n')
  ];
  for (const text of texts) watcher._handleClip(text, WIN);
  await sleep(400);
  watcher.stop();

  assert.strictEqual(batches.length, 3);
  assert.strictEqual(totalAdded(), 3);
  const contents = chatDb.messages('Hank', '', 20).messages.map((m) => m.content);
  assert.deepStrictEqual(contents.slice(-3), ['第一条', '第二条', '第三条'], '入库顺序要与复制顺序一致');
});

test('同一段文本被传感器重复上报只交付一次，且不会把别的批次挤掉', async () => {
  const { watcher, batches } = makeWatcher();
  watcher._handleClip(HANK, WIN);
  watcher._handleClip(HANK, WIN); // 抖动：同一段又报了一次
  watcher._handleClip(LUO, WIN); // 另一段真的复制了
  await sleep(400);
  watcher.stop();

  assert.strictEqual(batches.length, 2, '重复上报合并，另一段不能被挤掉');
  assert.deepStrictEqual(batches.map((b) => b.contact), ['Hank', '罗卜头']);
  assert.strictEqual(batches[0].repeat, false);
  assert.strictEqual(batches[1].repeat, false);
});

test('停止监听时，排队未交付的批次先落库再退出', async () => {
  const { watcher, batches, totalAdded } = makeWatcher();
  const last = ['罗卜头', '2026年9月18日 08:30', '停监听前的最后一条'].join('\n');
  watcher._handleClip(last, WIN);
  watcher.stop(); // 不等 250ms 就停
  assert.strictEqual(batches.length, 1, 'stop() 应把已排队的批次交付出去');
  assert.strictEqual(totalAdded(), 1, '排队的消息要真的落库');
  const contents = chatDb.messages('罗卜头', '', 20).messages.map((m) => m.content);
  assert.ok(contents.includes('停监听前的最后一条'));
});

test('不符合聊天记录格式的文本仍然不入库', async () => {
  const { watcher, batches } = makeWatcher();
  watcher._handleClip('随便一句普通的话', WIN);
  await sleep(400);
  watcher.stop();
  assert.strictEqual(batches.length, 0);
});
