// 意图识别：必须结合上下文与当前时间判断
// 回归点：
//  - 提示词要带「当前时间」与「前文背景」，否则「18 号说明天完成」在 22 号跑时仍会变成待办；
//  - 模型标了 expired，或截止时间已经过去很多天的，不再进入待确认列表。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-intent-'));
process.env.XIAOTIHU_DATA_DIR = tmp;

const chatDb = require('../core/memory/chat-db');
const { runIntentExtraction, formatNow, staleReason } = require('../core/engine/intent-runner');
const { buildIntentPrompt } = require('../core/engine/prompts/intent');
const { readIntents } = require('../core/memory/stores/intents');
const intentsStore = require('../core/memory/stores/intents');

const CFG = {
  selfNicknames: ['六壹'],
  notify: { mode: 'off' },
  intent: {
    provider: 'deepseek',
    model: 'mock',
    mediumConfidence: 0.5,
    staleDeadlineDays: 2
  },
  engine: { providers: { deepseek: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'test-key', model: 'mock' } } }
};

const daysFromNow = (n) => new Date(Date.now() + n * 86400000).toISOString();

test('提示词：带当前时间、前文背景与「已完成/过期不要输出」的规则', () => {
  const prompt = buildIntentPrompt({
    chatText: '2026-09-22 09:00 阿May: 这周的周报记得交',
    contextText: '2026-09-18 10:00 阿May: 明天把方案给我\n2026-09-18 10:05 六壹: 好的',
    sourceLabel: '阿May',
    now: '2026-09-22 13:40（周一）'
  });
  assert.ok(prompt.includes('当前时间：2026-09-22 13:40（周一）'));
  assert.ok(prompt.includes('前文背景'));
  assert.ok(prompt.includes('明天把方案给我'));
  assert.ok(prompt.includes('不要从前文里产出新的待办'));
  assert.ok(prompt.includes('已经做完、已经被取消、已经过期'));
  assert.ok(prompt.includes('该条消息自己的时间'));
  assert.ok(prompt.includes('"expired"'));
});

test('staleReason：截止时间过去太久才算过期', () => {
  const now = Date.now();
  assert.strictEqual(staleReason({ dueAt: new Date(now + 86400000).toISOString() }, now, 2), '');
  assert.strictEqual(staleReason({ dueAt: new Date(now - 3600000).toISOString() }, now, 2), '');
  assert.ok(staleReason({ dueAt: new Date(now - 5 * 86400000).toISOString(), dueText: '上周五' }, now, 2).includes('已经过去'));
  assert.strictEqual(staleReason({ dueAt: null, dueText: '下周' }, now, 2), '');
});

test('扫描：已完成/过期的被跳过，仍然成立的新意图才进待确认', async () => {
  chatDb.ingestMessages('阿May', [
    { name: '阿May', ts: '2026-09-18 10:00', type: 'text', content: '明天把方案给我' },
    { name: '六壹', ts: '2026-09-18 10:05', type: 'text', content: '好的' }
  ]);
  // 这一段是「新消息」：里面既有仍然成立的事，也有明显过期/已完成的事
  chatDb.ingestMessages('阿May', [
    { name: '阿May', ts: '2026-09-22 09:00', type: 'text', content: '这周的周报记得交' },
    { name: '阿May', ts: '2026-09-22 09:01', type: 'text', content: '上次说的方案我已经收到了，不用再发' }
  ]);

  // 模拟「增量扫描」：游标停在 18 号那两条上，于是本次批次只有 22 号的新消息，
  // 18 号的内容就变成了前文背景（这正是线上最容易误判成待办的场景）。
  const all = chatDb.messages('阿May', '', 60).messages;
  const firstNew = all.find((m) => m.content === '这周的周报记得交');
  const beforeNew = all.filter((m) => Number(m.id) < Number(firstNew.id)).pop();
  fs.writeFileSync(
    path.join(tmp, 'intent-state.json'),
    JSON.stringify({ '阿May': { id: beforeNew.id, ts: beforeNew.ts } }),
    'utf8'
  );

  const captured = [];
  const runTaskMock = async (taskName, ctx) => {
    captured.push({ taskName, ctx });
    return {
      ok: true,
      text: '[…]',
      array: [
        // 仍然成立 → 保留
        { type: 'todo', summary: '交本周周报', detail: '这周的周报记得交', deadline: daysFromNow(3), confidence: 0.9 },
        // 截止时间过去 5 天 → 跳过
        { type: 'todo', summary: '18 号说的方案', detail: '明天把方案给我', deadline: daysFromNow(-5), confidence: 0.9 },
        // 模型自己标了已完成/已过期 → 跳过
        { type: 'todo', summary: '已经收到的东西', detail: '不用再发', deadline: daysFromNow(2), expired: true, confidence: 0.8 }
      ]
    };
  };

  const result = await runIntentExtraction({ config: CFG, runTask: runTaskMock });
  assert.strictEqual(result.totalNew, 1, '只有仍然成立的那条应该入库');
  assert.strictEqual(result.totalStale, 2, '过期/已完成的两条应被跳过');

  const intents = readIntents();
  assert.strictEqual(intents.length, 1);
  assert.strictEqual(intents[0].summary, '交本周周报');
  assert.strictEqual(intents[0].status, 'pending_confirm');

  // 提示词里确实带上了前文背景与当前时间
  const ctx = captured[0].ctx;
  assert.ok(ctx.contextText.includes('明天把方案给我'), '应带上批次之前的前文背景');
  assert.ok(ctx.chatText.includes('这周的周报记得交'));
  assert.ok(/当前时间|（周[一二三四五六日]）/.test(ctx.now) || ctx.now.includes('周'), '应带上当前时间：' + ctx.now);
  assert.strictEqual(formatNow(new Date(2026, 8, 22, 13, 40)).startsWith('2026-09-22 13:40'), true);
});

test('重复扫描同一批消息：不重复生成待确认意图', async () => {
  const runTaskMock = async () => ({
    ok: true,
    text: '[…]',
    array: [{ type: 'todo', summary: '交本周周报', detail: '这周的周报记得交', deadline: daysFromNow(3), confidence: 0.9 }]
  });
  // 手动把游标退回去，模拟「同一批消息再扫一次」
  const statePath = path.join(tmp, 'intent-state.json');
  fs.writeFileSync(statePath, JSON.stringify({ '阿May': '' }), 'utf8');
  const result = await runIntentExtraction({ config: CFG, runTask: runTaskMock });
  assert.strictEqual(result.totalNew, 0, '同样的联系人+时间+内容+标题应判为重复');
  assert.strictEqual(readIntents().length, 1);
});

test('自动过期：旧的待确认事项在下次扫描时被标为已忽略', async () => {
  const items = readIntents();
  items.push({
    id: 'intent_old_1',
    type: 'todo',
    summary: '18 号说明天要交的方案',
    detail: '明天把方案给我',
    dueAt: daysFromNow(-10),
    dueText: '明天',
    status: 'pending_confirm',
    notified: true,
    confidence: 0.9,
    source: { contact: '阿May', ts: '2026-09-18 10:00', content: '明天把方案给我' }
  });
  items.push({
    id: 'intent_future_1',
    type: 'todo',
    summary: '下周要交的东西',
    detail: '下周交',
    dueAt: daysFromNow(5),
    dueText: '下周',
    status: 'pending_confirm',
    notified: true,
    confidence: 0.9,
    source: { contact: '阿May', ts: '2026-09-22 09:00', content: '下周交' }
  });
  intentsStore.saveIntents(items);

  const runTaskMock = async () => ({ ok: true, text: 'NO_TASK', array: null });
  const result = await runIntentExtraction({ config: CFG, runTask: runTaskMock });
  assert.strictEqual(result.expired, 1, '只应过期那一条旧的');

  const after = readIntents();
  const old = after.find((i) => i.id === 'intent_old_1');
  const future = after.find((i) => i.id === 'intent_future_1');
  assert.strictEqual(old.status, 'ignored');
  assert.ok(old.staleReason, '应记录过期原因');
  assert.strictEqual(future.status, 'pending_confirm', '未来的事项不受影响');
});
