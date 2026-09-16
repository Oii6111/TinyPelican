// 重复复制同一段聊天：
//  - 剪贴板层不能把「又复制了一次」静默吞掉（否则卡片永远不会再弹）；
//  - 服务层对同一段聊天复用既有那批建议（不重复调模型），并把卡片重新推给浮窗（showToken 自增）；
//  - 上下文变了（来了新消息）才重新生成。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-repeat-'));
process.env.XIAOTIHU_DATA_DIR = tmp;

const { ClipboardWatcher } = require('../core/capture/clipboard');
const chatDb = require('../core/memory/chat-db');
const store = require('../core/reply/suggestion-store');
const { generateReplySuggestions, latestTextMessage } = require('../core/reply/suggestions');

const CLIP = [
  'Hank',
  '2026年9月15日 21:30',
  '还有三创赛',
  '',
  '我',
  '2026年9月15日 21:31',
  '你可以的'
].join('\n');

const WIN = {
  handle: '123',
  pid: '9',
  processName: 'WeChat',
  bounds: { left: 0, top: 0, right: 800, bottom: 600 },
  dpi: 96
};

// 本机兜底模型地址：确保不会走 legacy/真实 API；万一真去调模型也只会在本地立刻失败。
const CFG = {
  engine: {
    retries: 0,
    provider: 'ollama',
    providers: { ollama: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' } }
  },
  capture: { enabled: true, replySuggestions: { enabled: true, timeoutMs: 400 } }
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 假的 OpenAI 兼容端点：统计被调用了几次
function startMockModel(onRequest) {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      onRequest(String(body || ''));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: 'mock',
        choices: [{ message: { role: 'assistant', content: '[{"tone":"自然","messages":["在的","你说"]}]' } }]
      }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

test('端到端：提示词把历史消息标成「你 / 对方」（回归：曾经全是 ?：）', async () => {
  let prompt = '';
  const srv = await startMockModel((body) => {
    try { prompt = JSON.parse(body).messages[0].content; } catch {}
  });
  const port = srv.address().port;
  const cfg = {
    selfNicknames: ['六壹'],
    engine: {
      retries: 0,
      provider: 'ollama',
      providers: { ollama: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock' } }
    },
    capture: { enabled: true, replySuggestions: { enabled: true, timeoutMs: 5000 } }
  };

  try {
    chatDb.ingestMessages('罗卜头', [
      { name: '六壹', ts: '2026-09-15 12:10', type: 'text', content: '我一会儿给你发个操作效果演示' },
      { name: '罗卜头', ts: '2026-09-15 12:12', type: 'text', content: '可以' }
    ]);

    const r = await generateReplySuggestions({ contact: '罗卜头', targetWindow: null, config: cfg });
    assert.strictEqual(r.ok, true, r.error);
    assert.ok(prompt.includes('你：我一会儿给你发个操作效果演示'), '用户的消息要标成「你」');
    assert.ok(prompt.includes('对方：可以'), '联系人的消息要标成「对方」');
    assert.ok(!prompt.includes('?：'), '历史行必须带发件人（chatDb 用 sender 字段）');
    assert.ok(prompt.includes('【视角】'));
  } finally {
    srv.close();
  }
});

test('端到端：第一次复制调模型，收起后再复制同一段聊天不再调模型、原样弹回', async () => {
  let modelCalls = 0;
  const srv = await startMockModel(() => { modelCalls++; });
  const port = srv.address().port;
  const cfg = {
    engine: {
      retries: 0,
      provider: 'ollama',
      providers: { ollama: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock' } }
    },
    capture: { enabled: true, replySuggestions: { enabled: true, timeoutMs: 5000 } }
  };

  try {
    chatDb.ingestMessages('Lucy', [
      { name: 'Lucy', ts: '2026-09-16 09:10', type: 'text', content: '在吗' }
    ]);

    const first = await generateReplySuggestions({ contact: 'Lucy', targetWindow: WIN, config: cfg });
    assert.strictEqual(first.ok, true, first.error);
    assert.strictEqual(modelCalls, 1);
    assert.strictEqual(first.suggestion.showToken, 1);

    // 用户点了 ✕ 收起：客户端只是隐藏浮窗，服务端建议保留（收起不发任何请求）
    assert.ok(store.getCurrent(), '收起不应丢掉服务端建议');

    // 再复制一次同一段聊天
    const again = await generateReplySuggestions({ contact: 'Lucy', targetWindow: WIN, config: cfg });
    assert.strictEqual(again.ok, true, again.error);
    assert.strictEqual(again.cached, true);
    assert.strictEqual(modelCalls, 1, '重复复制不该再调模型');
    assert.strictEqual(again.suggestion.id, first.suggestion.id);
    assert.strictEqual(again.suggestion.showToken, 2, 'showToken 自增，浮窗才会重新弹出');
  } finally {
    srv.close();
  }
});

test('剪贴板：同一段聊天再复制一次也会回调（repeat 标记，且不重复归档）', async () => {
  const batches = [];
  const watcher = new ClipboardWatcher({
    onBatch: (b) => batches.push(b),
    config: { selfNicknames: ['我'], capture: { enabled: true }, pollMs: 700, minMatchLines: 2 }
  });

  watcher._handleClip(CLIP, WIN);
  await sleep(700);
  watcher._handleClip(CLIP, WIN);
  await sleep(700);
  watcher.stop();

  assert.strictEqual(batches.length, 2, '两次复制都要回调，否则收起后卡片不会再弹出来');
  assert.strictEqual(batches[0].repeat, false);
  assert.strictEqual(batches[0].msgs.length, 2);
  assert.strictEqual(batches[0].contact, 'Hank');

  assert.strictEqual(batches[1].repeat, true);
  assert.deepStrictEqual(batches[1].msgs, [], '重复复制没有新消息要归档');
  assert.strictEqual(batches[1].contact, 'Hank');
  assert.strictEqual(batches[1].targetWindow.handle, '123');
});

test('重复复制：把既有建议原样重新推给浮窗（同 id、showToken 自增、刷新有效期与定位）', async () => {
  chatDb.ingestMessages('Hank', [
    { name: 'Hank', ts: '2026-09-15 21:30', type: 'text', content: '还有三创赛' },
    { name: '我', ts: '2026-09-15 21:31', type: 'text', content: '你可以的' }
  ]);
  const doc = chatDb.contactContext('Hank', { limit: 16 });
  const latest = latestTextMessage(doc);
  const fingerprint = ['Hank', latest.name, latest.ts, latest.type, latest.content].join('|');

  store.invalidate();
  store.replaceSuggestion({
    id: 'reply_repeat_1',
    contact: 'Hank',
    sourceMessage: latest.content,
    sourceFingerprint: fingerprint,
    hint: '',
    plans: [{ tone: '自然', messages: ['三创赛也上了', '大一就这么猛'] }],
    context: { contact: 'Hank', avoid: ['三创赛也上了 / 大一就这么猛'] },
    targetWindow: { handle: '111', pid: '9', processName: 'WeChat', bounds: null, dpi: 0 },
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 1000,
    showToken: 1
  });
  const beforeExpiry = store.getCurrent().expiresAt;

  const r = await generateReplySuggestions({
    contact: 'Hank',
    targetWindow: { handle: '222', pid: '9', processName: 'WeChat', bounds: null, dpi: 0 },
    config: CFG
  });

  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.cached, true, '同一段聊天不应重新调模型');
  assert.strictEqual(r.suggestion.id, 'reply_repeat_1');
  assert.strictEqual(r.suggestion.showToken, 2, 'showToken 变化才会让浮窗重新弹出');
  assert.deepStrictEqual(r.suggestion.plans, [{ tone: '自然', messages: ['三创赛也上了', '大一就这么猛'] }]);
  assert.ok(store.getCurrent().expiresAt > beforeExpiry, '重复复制应续上有效期');
  assert.strictEqual(store.getCurrent().targetWindow.handle, '222', '应按最近一次复制重新定位');
});

test('上下文变了（又来了新消息）：不复用旧建议，走重新生成', async () => {
  chatDb.ingestMessages('Hank', [
    { name: 'Hank', ts: '2026-09-15 21:40', type: 'text', content: '决赛在周六' }
  ]);
  const r = await generateReplySuggestions({ contact: 'Hank', targetWindow: null, config: CFG });
  assert.strictEqual(r.cached, undefined, '最新消息变了就不该复用');
  // 本机没有可用模型，所以这里必然是失败；关键是它确实去重新生成了
  assert.strictEqual(r.ok, false);
});
