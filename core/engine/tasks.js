// 小鹈鹕核心 — 任务注册表
// 每个任务 = 提示词构造 + 输出解析；业务代码只按任务名调用。
'use strict';

const { buildIntentPrompt } = require('./prompts/intent');
const { buildRelationPrompt } = require('./prompts/relation');
const { buildReminderPrompt } = require('./prompts/reminder');
const { buildReplySuggestionsPrompt, buildReplyFollowUpPrompt } = require('./prompts/reply-suggestions');
const { extractJsonArray } = require('./extract');
const { buildDailyActionsPrompt, parseDailyActions, buildDailyActionPlanPrompt, parseDailyActionPlan } = require('./prompts/daily-actions');

const TASKS = {
  // 今日行动：按社交目的 + 客观聊天事实，为一位联系人给 1–2 条社交关系维护建议。
  // 节奏（隔几天）和内容同一次判出来，服务端再套护栏（见 core/social/cadence.js）。
  daily_actions: {
    opts: { temperature: 0.5, timeoutMs: 60000, retries: 0, thinking: false },
    buildPrompt: (ctx) => buildDailyActionsPrompt(ctx),
    parse: (text, ctx) => parseDailyActions(text, ctx)
  },
  // 点开某条建议时按需生成的详细行动计划（3–5 步 + 分支 + 边界），不是常驻对话。
  daily_action_plan: {
    opts: { temperature: 0.5, timeoutMs: 60000, retries: 0, thinking: false },
    buildPrompt: (ctx) => buildDailyActionPlanPrompt(ctx),
    parse: (text) => parseDailyActionPlan(text)
  },
  // 意图识别：返回原始文本 + 解析出的数组，由调用方按 NO_TASK / JSON 分流
  intent: {
    opts: { temperature: 0.1 },
    buildPrompt: (ctx) => buildIntentPrompt(ctx),
    parse: (text) => ({ ok: true, text, array: extractJsonArray(text) })
  },
  relation: {
    opts: { temperature: 0.8 },
    buildPrompt: (ctx) => buildRelationPrompt(ctx.contact, ctx.userPersona),
    parse: (text) => ({ ok: true, text })
  },
  reminder_text: {
    opts: { temperature: 0.7 },
    buildPrompt: (ctx) => buildReminderPrompt(ctx.intent),
    parse: (text) => ({ ok: true, text })
  },
  reply_suggestions: {
    // thinking: false = 不让模型先吐思考过程（DeepSeek 等混合模型能快好几倍，见 client.js）
    opts: { temperature: 0.75, timeoutMs: 30000, thinking: false },
    buildPrompt: (ctx) => buildReplySuggestionsPrompt(ctx),
    parse: (text) => ({ ok: true, text, array: extractJsonArray(text) })
  },
  // 用户已经按一组方案发出去前几条，只重写「剩下的几条」（必须带上已发内容做上下文）
  reply_followup: {
    opts: { temperature: 0.75, timeoutMs: 30000, thinking: false },
    buildPrompt: (ctx) => buildReplyFollowUpPrompt(ctx),
    parse: (text) => ({ ok: true, text, array: extractJsonArray(text) })
  }
};

function getTask(name) {
  return TASKS[name] || null;
}

module.exports = { TASKS, getTask };
