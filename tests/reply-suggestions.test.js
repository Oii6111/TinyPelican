'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 这些用例会 require 到 chat-db（会按数据目录建库），指向临时目录，别碰真实数据
process.env.XIAOTIHU_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-reply-'));

const { parseSensorLine } = require('../core/capture/clipboard');
const internalClipboard = require('../core/capture/internal-clipboard');
const { latestTextMessage, normalizePlans, canSuggest, generateReplySuggestions, regenerateRemaining } = require('../core/reply/suggestions');
const { buildReplySuggestionsPrompt } = require('../core/engine/prompts/reply-suggestions');
const store = require('../core/reply/suggestion-store');
const { applyPlan, applyNext, resetSequence, describeFailure } = require('../core/reply/window-paste');

test('剪贴板传感器新/旧格式解析', () => {
  const full = parseSensorLine('CHANGE 123456 999 WeChat.exe aGVsbG8=');
  assert.strictEqual(full.handle, '123456');
  assert.strictEqual(full.pid, '999');
  assert.strictEqual(full.processName, 'WeChat.exe');
  assert.strictEqual(full.encoded, 'aGVsbG8=');

  const current = parseSensorLine('CHANGE 123456 aGVsbG8=');
  assert.strictEqual(current.handle, '123456');
  assert.strictEqual(current.encoded, 'aGVsbG8=');

  const zero = parseSensorLine('CHANGE 0 aGVsbG8=');
  assert.strictEqual(zero.handle, null);

  const legacy = parseSensorLine('CHANGE aGVsbG8=');
  assert.strictEqual(legacy.handle, null);
  assert.strictEqual(legacy.encoded, 'aGVsbG8=');

  const rect = parseSensorLine('CHANGE 986432 999 WeChat 200 100 1400 900 144 aGVsbG8=');
  assert.strictEqual(rect.handle, '986432');
  assert.strictEqual(rect.processName, 'WeChat');
  assert.deepStrictEqual(rect.bounds, { left: 200, top: 100, right: 1400, bottom: 900 });
  assert.strictEqual(rect.dpi, 144);
  assert.strictEqual(rect.encoded, 'aGVsbG8=');

  assert.strictEqual(parseSensorLine('CHANGE'), null);
});

test('内部剪贴板写入只忽略内容相同的那一次', () => {
  internalClipboard.clearInternalWrite();
  internalClipboard.markInternalWrite('建议文本A');
  assert.strictEqual(internalClipboard.isInternalClipboardWrite('建议文本A'), true);
  assert.strictEqual(internalClipboard.isInternalClipboardWrite('建议文本A'), false);
  assert.strictEqual(internalClipboard.isInternalClipboardWrite('用户紧接着复制的新聊天'), false);
  internalClipboard.clearInternalWrite();
});

test('最后一条文本消息不区分发送方', () => {
  const doc = {
    messages: [
      { name: 'Hank', ts: '2026-08-29 10:00', type: 'text', content: '你明天有时间吗？' },
      { name: '我', ts: '2026-08-29 10:01', type: 'text', content: '有的' },
      { name: 'Hank', ts: '2026-08-29 10:02', type: '图片', content: '' }
    ]
  };
  const latest = latestTextMessage(doc);
  assert.ok(latest);
  assert.strictEqual(latest.content, '有的');

  assert.strictEqual(latestTextMessage({ messages: [] }), null);
  assert.strictEqual(latestTextMessage({ messages: [{ name: 'Hank', type: '图片', content: '' }] }), null);
});

test('方案规范化：多组连贯消息、兼容单条格式、去重/限长/限条数', () => {
  const out = normalizePlans([
    { tone: '自然', messages: ['在的', '你说'] },
    { tone: '关心', messages: ['在的', '你说'] },          // 与上一组完全重复
    { tone: '简洁', messages: [] },                        // 空方案丢弃
    { tone: '正式', text: '单条旧格式' },                   // 兼容 { tone, text }
    { tone: '自然', messages: ['  ', 'x'.repeat(600)] },    // 空/超长消息丢弃
    { tone: '简洁', messages: ['收到'] }
  ], { planCount: 4, maxMessagesPerPlan: 3, maxChars: 120 });

  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(out.map((p) => p.messages), [['在的', '你说'], ['单条旧格式'], ['收到']]);

  // 单组最多消息数截断
  const capped = normalizePlans([{ tone: '自然', messages: ['一', '二', '三', '四'] }], { maxMessagesPerPlan: 2 });
  assert.deepStrictEqual(capped[0].messages, ['一', '二']);

  // 方案数量上限
  const many = normalizePlans([
    { tone: 'a', messages: ['1'] },
    { tone: 'b', messages: ['2'] },
    { tone: 'c', messages: ['3'] }
  ], { planCount: 2 });
  assert.strictEqual(many.length, 2);

  assert.deepStrictEqual(normalizePlans(null), []);
  assert.deepStrictEqual(normalizePlans([{ tone: '自然', text: 'x'.repeat(600) }], { maxChars: 5 }), []);
});

test('提示词视角：历史行按「你 / 对方」标注，发件人字段是 sender 也不丢', () => {
  const prompt = buildReplySuggestionsPrompt({
    contact: '罗卜头',
    selfNicknames: ['六壹'],
    history: [
      { sender: '六壹', ts: '2026-09-15 12:10', type: 'text', content: '我一会儿给你发个操作效果演示' },
      { sender: '罗卜头', ts: '2026-09-15 12:12', type: 'text', content: '可以' },
      { sender: '罗卜头', ts: '2026-09-15 12:20', type: '图片', content: '' }
    ],
    latestMessage: { text: '可以', speaker: '罗卜头', isSelf: false },
    planCount: 3,
    maxMessagesPerPlan: 3,
    maxMessageChars: 40
  });

  assert.ok(prompt.includes('你：我一会儿给你发个操作效果演示'), '用户自己的消息要标成「你」');
  assert.ok(prompt.includes('对方：可以'), '联系人的消息要标成「对方」');
  assert.ok(prompt.includes('对方：[图片]'), '非文本消息保留占位，不要整行丢掉');
  assert.ok(!prompt.includes('?：'), 'chatDb 历史用 sender 字段，不能退化成 ?：');
  assert.ok(prompt.includes('【视角】'));
  assert.ok(prompt.includes('罗卜头'));
  assert.ok(prompt.includes('来自对方（联系人） 罗卜头'));

  // 没配置自己的昵称时退回昵称原文，绝不硬标成「你」
  const unknown = buildReplySuggestionsPrompt({
    contact: 'X',
    selfNicknames: [],
    history: [{ sender: 'A', type: 'text', content: 'hi' }]
  });
  assert.ok(unknown.includes('A：hi'));
  assert.ok(!unknown.includes('你：hi'));

  // 最后一条是自己发的：视角说明也要跟着变
  const selfLatest = buildReplySuggestionsPrompt({
    contact: 'X',
    selfNicknames: ['六壹'],
    history: [{ sender: '六壹', type: 'text', content: '晚点聊' }],
    latestMessage: { text: '晚点聊', speaker: '六壹', isSelf: true }
  });
  assert.ok(selfLatest.includes('来自你（用户） 六壹'));
});

test('重新生成：没有当前建议时直接失败，不触碰模型', async () => {
  store.invalidate();
  const rotate = await generateReplySuggestions({ rotate: true, config: { capture: { enabled: true, replySuggestions: { enabled: true } } } });
  assert.strictEqual(rotate.ok, false);
  assert.ok(rotate.error);

  const withHint = await generateReplySuggestions({ hint: '婉拒他', config: { capture: { enabled: true, replySuggestions: { enabled: true } } } });
  assert.strictEqual(withHint.ok, false);
});

test('顺序回填：建议不存在/状态为空时返回错误且不动状态', async () => {
  store.invalidate();
  assert.strictEqual((await applyPlan('nope', 0)).ok, false);
  assert.strictEqual((await applyNext('nope')).ok, false);
  assert.strictEqual(resetSequence('nope').ok, false);

  store.replaceSuggestion({
    id: 'reply_seq_1',
    contact: 'Hank',
    sourceMessage: '在吗',
    plans: [{ tone: '自然', messages: ['在的'] }],
    targetWindow: null,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 100000
  });
  // 还没有开始顺序发送时，“下一条”不可用
  assert.strictEqual((await applyNext('reply_seq_1')).ok, false);
});

test('回填失败信息：脚本标记给人话，脚本解析错误带出 PowerShell 原文', () => {
  assert.ok(describeFailure('NO_WINDOW', '', 2).includes('微信'));
  assert.ok(describeFailure('FOREGROUND_BLOCKED', '', 4).includes('已复制'));
  assert.ok(describeFailure('CLIPBOARD_FAILED', '', 1).includes('剪贴板'));
  assert.ok(describeFailure('INTEROP_FAILED 系统找不到指定文件', '', 1).includes('系统接口'));

  // 曾经的线上问题：脚本没有 BOM -> PowerShell 解析失败，退出码 1 且 stdout 为空
  const stderr = [
    'At C:\\x\\paste-to-window.ps1:6 char:1',
    '+ )',
    '+ ~',
    "Unexpected token ')' in expression or statement."
  ].join('\n');
  const msg = describeFailure('', stderr, 1);
  assert.ok(msg.includes('Unexpected token'), '应把 PowerShell 报错带出来：' + msg);
  assert.ok(msg.includes('退出码 1'));
  assert.strictEqual(describeFailure('', '', 1), '脚本退出码 1');
});

test('触发条件：剪贴板开启、私聊联系人、建议开关', () => {
  const cfg = {
    capture: {
      enabled: true,
      replySuggestions: { enabled: true }
    }
  };
  assert.strictEqual(canSuggest({ contact: 'Hank', cfg }), true);
  assert.strictEqual(canSuggest({ contact: '', cfg }), false);
  assert.strictEqual(canSuggest({ contact: 'Hank', cfg: { capture: { enabled: true, replySuggestions: { enabled: false } } } }), false);
  assert.strictEqual(canSuggest({ contact: 'Hank', cfg: { capture: { enabled: false, replySuggestions: { enabled: true } } } }), false);
});

test('建议状态：过期/失效/锁定/消费/忽略', () => {
  store.invalidate();
  const base = {
    id: 'reply_test_1',
    contact: 'Hank',
    sourceMessage: '好的',
    options: [{ tone: '自然', text: '嗯嗯' }],
    targetWindow: { handle: '123' },
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 100000
  };

  store.replaceSuggestion({ ...base });
  assert.strictEqual(store.getCurrent().id, 'reply_test_1');
  assert.strictEqual(store.sanitize(store.getCurrent()).canPaste, true);
  assert.strictEqual(store.sanitize(store.getCurrent()).targetWindow, undefined);

  assert.strictEqual(store.lock('reply_test_1'), true);
  // 已有锁时，无论是否同 ID，都必须拒绝第二次申请（防止并发粘贴两次）
  assert.strictEqual(store.lock('reply_test_1'), false);
  store.unlock('reply_test_1');
  assert.strictEqual(store.lock('reply_test_1'), true, '解锁后应能再次申请');
  store.unlock('reply_test_1');

  store.replaceSuggestion({ ...base, id: 'reply_test_2', expiresAt: Date.now() - 1 });
  assert.strictEqual(store.getCurrent(), null);

  store.replaceSuggestion({ ...base, id: 'reply_test_3' });
  store.invalidate();
  assert.strictEqual(store.getCurrent(), null);
});

test('建议 sanitize 只暴露计算后的 anchor，不暴露窗口句柄', () => {
  store.invalidate();
  store.replaceSuggestion({
    id: 'reply_anchor_1',
    contact: '张三',
    sourceMessage: '',
    plans: [{ tone: '自然', messages: ['好的', '明天见'] }],
    targetWindow: {
      handle: '986432',
      bounds: { left: 200, top: 100, right: 1400, bottom: 900 },
      dpi: 144
    },
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 100000
  });
  const out = store.sanitize(store.getCurrent());
  assert.deepStrictEqual(out.anchor, { x: 863, y: 465 });
  assert.strictEqual(out.targetWindow, undefined);
  assert.strictEqual(out.canPaste, true);
  assert.deepStrictEqual(out.plans, [{ tone: '自然', messages: ['好的', '明天见'] }]);
  assert.strictEqual(out.activePlan, null);
});

test('方案 sanitize：暴露 plans/activePlan/hint，不暴露生成上下文', () => {
  store.invalidate();
  store.replaceSuggestion({
    id: 'reply_plan_1',
    contact: '张三',
    sourceMessage: '在吗',
    sourceSpeaker: '张三',
    sourceIsSelf: false,
    hint: '婉拒',
    plans: [
      { tone: '自然', messages: ['在的', '怎么了'] },
      { tone: '简洁', messages: ['在'] }
    ],
    activePlan: { planIndex: 0, tone: '自然', sent: ['在的'], remaining: ['怎么了'] },
    context: { contact: '张三', targetWindow: { handle: '999' }, history: [] },
    targetWindow: { handle: '986432' },
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 100000
  });

  const out = store.sanitize(store.getCurrent());
  assert.deepStrictEqual(out.plans[0].messages, ['在的', '怎么了']);
  assert.deepStrictEqual(out.activePlan, { planIndex: 0, tone: '自然', sent: ['在的'], remaining: ['怎么了'] });
  assert.strictEqual(out.hint, '婉拒');
  assert.strictEqual(out.context, undefined);

  // 顺序状态只保留在服务端状态里，复位后回到方案选择态
  assert.deepStrictEqual(store.getActivePlan('reply_plan_1').remaining, ['怎么了']);
  store.setActivePlan('reply_plan_1', null);
  assert.strictEqual(store.sanitize(store.getCurrent()).activePlan, null);
  assert.strictEqual(store.setActivePlan('wrong', { planIndex: 1 }), null);
});


test('生成序号乱序防护：invalidate 也会推进版本', () => {
  store.invalidate();
  const a = store.beginGeneration();
  assert.strictEqual(store.isLatestGeneration(a), true);
  // 模拟期间来了无法识别的新剪贴板事件：invalidate 必须让在途请求作废
  store.invalidate();
  assert.strictEqual(store.isLatestGeneration(a), false);
  const b = store.beginGeneration();
  assert.strictEqual(store.isLatestGeneration(b), true);
});

// 起一个假的 OpenAI 兼容端点，用来端到端验证「提示词 -> 解析 -> 规范化 -> 状态」
function startMockModel(onRequest) {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch {}
      const prompt = String(((payload.messages || [])[0] || {}).content || '');
      const content = await onRequest(prompt, payload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock', choices: [{ message: { role: 'assistant', content } }] }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

function mockConfig(port) {
  return {
    engine: {
      provider: 'ollama',
      providers: { ollama: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock' } }
    },
    capture: { enabled: true, replySuggestions: { enabled: true } }
  };
}

function seedSuggestion() {
  const context = {
    contact: 'Hank',
    remark: '同事',
    profile: { 关系: '同事' },
    socialGoal: '',
    history: [
      { name: 'Hank', content: '在吗' },
      { name: '我', content: '在' }
    ],
    olderConversationContext: [],
    latestMessage: { text: '你明天有空吗', speaker: 'Hank', isSelf: false, timestamp: '2026-09-15 10:00' },
    selfNicknames: ['我'],
    sourceFingerprint: 'Hank|Hank|2026-09-15 10:00|text|你明天有空吗',
    avoid: ['有空 / 明天见']
  };
  store.invalidate();
  store.replaceSuggestion({
    id: store.createId(),
    contact: 'Hank',
    sourceMessage: '你明天有空吗',
    sourceSpeaker: 'Hank',
    sourceIsSelf: false,
    plans: [{ tone: '自然', messages: ['有空', '明天见'] }],
    context,
    targetWindow: { handle: '123', pid: '9', processName: 'WeChat.exe', bounds: null, dpi: 0 },
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 100000
  });
  return context;
}

test('按用户描述重写：提示词带上描述与“不要重复”，返回多组连贯消息', async () => {
  seedSuggestion();
  const prompts = [];
  const srv = await startMockModel((prompt) => {
    prompts.push(prompt);
    return '```json\n[{"tone":"自然","messages":["明天下午可以","你定个时间?"]},{"tone":"简洁","messages":["可以"]}]\n```';
  });
  const port = srv.address().port;
  try {
    const r = await generateReplySuggestions({ hint: '明天下午有空，但需要他定时间', config: mockConfig(port) });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.suggestion.contact, 'Hank');
    assert.strictEqual(r.suggestion.hint, '明天下午有空，但需要他定时间');
    assert.deepStrictEqual(r.suggestion.plans, [
      { tone: '自然', messages: ['明天下午可以', '你定个时间?'] },
      { tone: '简洁', messages: ['可以'] }
    ]);
    assert.strictEqual(r.suggestion.activePlan, null);
    assert.strictEqual(r.suggestion.canPaste, true);

    const prompt = prompts[0];
    assert.ok(prompt.includes('明天下午有空，但需要他定时间'), '提示词应包含用户描述');
    assert.ok(prompt.includes('有空 / 明天见'), '提示词应带上已给过的方案');
    assert.ok(prompt.includes('messages'), '提示词应要求 messages 数组');
    // 换一批时上下文被复用：同一段聊天、同一联系人
    assert.ok(prompt.includes('你明天有空吗'));
    assert.strictEqual(store.getCurrent().sourceMessage, '你明天有空吗');
  } finally {
    srv.close();
  }
});

test('换一批：不重新读剪贴板，沿用同一段聊天并累积“不要重复”清单', async () => {
  seedSuggestion();
  const prompts = [];
  const srv = await startMockModel((prompt) => {
    prompts.push(prompt);
    return '[{"tone":"关心","messages":["这周都在忙, 下周呢?"]}]';
  });
  const port = srv.address().port;
  try {
    const r = await generateReplySuggestions({ rotate: true, config: mockConfig(port) });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.suggestion.plans, [{ tone: '关心', messages: ['这周都在忙, 下周呢?'] }]);
    assert.strictEqual(r.suggestion.hint, '');
    assert.ok(prompts[0].includes('有空 / 明天见'));
    // 上一批（含刚生成的那组）会进入下一轮的“不要重复”清单
    const avoid = store.getCurrent().context.avoid;
    assert.ok(avoid.includes('这周都在忙, 下周呢?'));
    assert.ok(avoid.includes('有空 / 明天见'));

    const again = await generateReplySuggestions({ rotate: true, config: mockConfig(port) });
    assert.strictEqual(again.ok, true);
    assert.ok(prompts[1].includes('这周都在忙, 下周呢?'), '第二轮应把上一轮结果也算作不要重复');
  } finally {
    srv.close();
  }
});

test('模型输出不可用时保留原建议，不会把卡片清空', async () => {
  seedSuggestion();
  const srv = await startMockModel(() => '我建议你说：明天见');
  const port = srv.address().port;
  try {
    const r = await generateReplySuggestions({ hint: '客气一点', config: mockConfig(port) });
    assert.strictEqual(r.ok, false);
    assert.ok(store.getCurrent(), '生成失败时原建议应保留');
    assert.strictEqual(store.getCurrent().sourceMessage, '你明天有空吗');
  } finally {
    srv.close();
  }
});

// 快速模式用 deepseek 风格的 mock（能验证思考开关）：思考必须关掉，条数/字数上限也收紧
function deepseekMockConfig(port, rs = {}) {
  return {
    engine: {
      retries: 0,
      provider: 'deepseek',
      providers: { deepseek: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'deepseek-flash' } }
    },
    capture: { enabled: true, replySuggestions: { enabled: true, timeoutMs: 5000, ...rs } }
  };
}

test('快速模式：关思考 + 每组 4 条以内；深度思考：开思考 + 放宽到 8 条、更长', async () => {
  const seen = [];
  const srv = await startMockModel((prompt, payload) => {
    seen.push({ prompt, thinking: payload.thinking });
    return '[{"tone":"自然","messages":["好"]}]';
  });
  const port = srv.address().port;
  try {
    seedSuggestion();
    const fast = await generateReplySuggestions({ hint: '随便回一下', config: deepseekMockConfig(port) });
    assert.strictEqual(fast.ok, true, fast.error);
    seedSuggestion();
    const deep = await generateReplySuggestions({ hint: '随便回一下', deep: true, config: deepseekMockConfig(port) });
    assert.strictEqual(deep.ok, true, deep.error);

    // 快速模式：关思考 + 收紧上限
    assert.deepStrictEqual(seen[0].thinking, { type: 'disabled' }, '快速模式要关掉模型思考');
    assert.ok(seen[0].prompt.includes('每组包含 1~4 条消息'));
    assert.ok(seen[0].prompt.includes('不超过 40 个字'));

    // 深度思考：不传关思考参数（走模型默认的思考模式）+ 放宽上限
    assert.strictEqual(seen[1].thinking, undefined, '深度思考不能关掉思考');
    assert.ok(seen[1].prompt.includes('每组包含 1~8 条消息'));
    assert.ok(seen[1].prompt.includes('不超过 120 个字'));
  } finally {
    srv.close();
  }
});

test('生成中：先把 pending 挂出来（浮窗先显示“思考中”），返回后清掉', async () => {
  seedSuggestion();
  const srv = await startMockModel(async () => {
    await new Promise((r) => setTimeout(r, 250));
    return '[{"tone":"自然","messages":["好的"]}]';
  });
  const port = srv.address().port;
  try {
    const task = generateReplySuggestions({ hint: '客气一点', config: deepseekMockConfig(port) });
    await new Promise((r) => setTimeout(r, 80));
    const pending = store.sanitizePending(store.getPending());
    assert.ok(pending, '生成期间应有 pending，浮窗才能先弹出来');
    assert.strictEqual(pending.contact, 'Hank');
    assert.strictEqual(pending.mode, 'fast');
    assert.strictEqual(pending.hint, '客气一点');
    assert.ok(pending.startedAt);

    const r = await task;
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(store.getPending(), null, '生成结束要清掉 pending');
  } finally {
    srv.close();
  }
});

test('顺序发送中换一批：只重写剩下的几条，并把已发的带进提示词', async () => {
  seedSuggestion();
  const prompts = [];
  const srv = await startMockModel((prompt) => {
    prompts.push(prompt);
    return '[{"tone":"自然","messages":["那我等你消息","不急, 你忙完再说"]}]';
  });
  const port = srv.address().port;
  try {
    // 模拟用户已经点过第 1、2 条
    store.setActivePlan(store.getCurrent().id, {
      planIndex: 0,
      tone: '自然',
      sent: ['明天下午可以', '你定个时间?'],
      remaining: ['那我等你消息', '别放我鸽子']
    });

    const r = await regenerateRemaining({ config: deepseekMockConfig(port) });
    assert.strictEqual(r.ok, true, r.error);

    const prompt = prompts[0];
    assert.ok(prompt.includes('刚刚发出去'), '续写提示词必须说明已发内容');
    assert.ok(prompt.includes('1. 明天下午可以'));
    assert.ok(prompt.includes('2. 你定个时间?'));
    assert.ok(prompt.includes('别放我鸽子'), '已经给过的那几条要进“不要重复”清单');

    const active = store.getActivePlan(store.getCurrent().id);
    assert.deepStrictEqual(active.sent, ['明天下午可以', '你定个时间?'], '已发的不能被改动');
    assert.deepStrictEqual(active.remaining, ['那我等你消息', '不急, 你忙完再说'], '剩下的几条应被重写');
    // 已经试过的那几条进「不要重复」清单（按组拼接，和 planTexts 一致）
    assert.ok(active.avoid.includes('那我等你消息 / 别放我鸽子'));
  } finally {
    srv.close();
  }
});

test('不在顺序发送中时，重写剩余消息直接失败（不会误触发模型）', async () => {
  seedSuggestion();
  const r = await regenerateRemaining({ config: mockConfig(9) });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
});
