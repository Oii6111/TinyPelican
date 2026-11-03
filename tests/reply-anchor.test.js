// 回复建议浮窗的定位：微信窗口识别 + 锚点计算 + 无效矩形的兜底
// 回归点：
//  - 微信 4.x 的 WeChatAppEx（独立聊天窗口/内置浏览器进程）也要认成微信，否则拿不到矩形；
//  - 最小化窗口的 -32000 坐标不能用来算锚点，否则卡片会被甩到屏幕外；
//  - 合法矩形算出的锚点要落在窗口右下角偏内（输入框附近），供 Electron 定位卡片。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-reply-anchor-'));
process.env.XIAOTIHU_DATA_DIR = tmp;

const { ClipboardWatcher, isWeixinProcess, usableWindowBounds } = require('../core/capture/clipboard');
const store = require('../core/reply/suggestion-store');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeWatcher(batches) {
  return new ClipboardWatcher({
    onBatch: (batch) => batches.push(batch),
    config: { selfNicknames: ['我'], capture: { enabled: true }, pollMs: 700, minMatchLines: 2 }
  });
}

const CHAT = ['Hank', '2026年9月15日 21:30', '明天下午三点开会'].join('\n');
const RECT = { left: 100, top: 120, right: 980, bottom: 760 };

function sensorWindow(processName, bounds, dpi = 96) {
  return { handle: '2296602', pid: '63092', processName, bounds, dpi };
}

test('微信相关进程都要被认成微信（含 4.x 的 WeChatAppEx）', () => {
  for (const name of ['WeChat', 'WeChat.exe', 'Weixin', 'Weixin.exe', 'WeChatAppEx', 'WeChatAppEx.exe', 'weixin']) {
    assert.strictEqual(isWeixinProcess(name), true, name + ' 应被识别为微信');
  }
  for (const name of ['msedge', 'msedge.exe', 'WeChatAppEx2', 'WeChatting', '', null, undefined]) {
    assert.strictEqual(isWeixinProcess(name), false, String(name) + ' 不应被识别为微信');
  }
});

test('最小化窗口的 -32000 坐标和异常矩形都判为不可用', () => {
  assert.strictEqual(usableWindowBounds(RECT), true);
  assert.strictEqual(usableWindowBounds({ left: -18286, top: -18286, right: -18128, bottom: -18260 }), false);
  assert.strictEqual(usableWindowBounds({ left: 0, top: 0, right: 0, bottom: 600 }), false);
  assert.strictEqual(usableWindowBounds({ left: 0, top: 0, right: 30000, bottom: 600 }), false);
  assert.strictEqual(usableWindowBounds(null), false);
  assert.strictEqual(usableWindowBounds({ left: 'a', top: 0, right: 100, bottom: 100 }), false);
});

test('WeChatAppEx 复制聊天时能把窗口矩形带进批次（卡片才能贴到输入框）', async () => {
  const batches = [];
  const watcher = makeWatcher(batches);
  watcher._handleClip(CHAT, sensorWindow('WeChatAppEx', RECT));
  await sleep(400);
  watcher.stop();

  assert.strictEqual(batches.length, 1);
  const target = batches[0].targetWindow;
  assert.ok(target, '批次应带上目标窗口');
  assert.deepStrictEqual(target.bounds, RECT);
  assert.strictEqual(target.dpi, 96);
});

test('微信最小化时矩形不可用：批次仍然入库，但不带定位信息', async () => {
  const batches = [];
  const watcher = makeWatcher(batches);
  watcher._handleClip(CHAT, sensorWindow('Weixin', { left: -18286, top: -18286, right: -18128, bottom: -18260 }));
  await sleep(400);
  watcher.stop();

  assert.strictEqual(batches.length, 1, '定位失败不影响归档');
  assert.ok(batches[0].targetWindow, '句柄仍保留给粘贴用');
  assert.strictEqual(batches[0].targetWindow.bounds, null);
  assert.strictEqual(batches[0].targetWindow.dpi, 0);
});

test('非微信窗口（例如浏览器）不采用窗口矩形', async () => {
  const batches = [];
  const watcher = makeWatcher(batches);
  watcher._handleClip(CHAT, sensorWindow('msedge', RECT));
  await sleep(400);
  watcher.stop();

  assert.strictEqual(batches.length, 1);
  assert.strictEqual(batches[0].targetWindow.bounds, null);
});

test('锚点按窗口右下角偏内计算（发送按钮附近）', () => {
  store.replaceSuggestion({
    id: 'reply_anchor_test',
    contact: 'Hank',
    plans: [{ tone: '自然', messages: ['好'] }],
    targetWindow: { handle: '1', processName: 'WeChatAppEx', bounds: RECT, dpi: 96 },
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 60000
  });
  const anchor = store.sanitize(store.getCurrent()).anchor;
  assert.deepStrictEqual(anchor, { x: 910, y: 625 });
  store.invalidate();
});

test('没有可用矩形时锚点为空（Electron 用鼠标位置兜底）', () => {
  store.replaceSuggestion({
    id: 'reply_anchor_none',
    contact: 'Hank',
    plans: [{ tone: '自然', messages: ['好'] }],
    targetWindow: { handle: '1', processName: 'WeChatAppEx', bounds: null, dpi: 0 },
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 60000
  });
  const sanitized = store.sanitize(store.getCurrent());
  assert.strictEqual(sanitized.anchor, null);
  assert.strictEqual(sanitized.canPaste, true, '句柄还在，仍然可以粘贴');
  store.invalidate();
});
