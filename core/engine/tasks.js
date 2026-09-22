// 小鹈鹕核心 — 任务注册表
// 每个任务 = 提示词构造 + 输出解析；业务代码只按任务名调用。
'use strict';

const { buildIntentPrompt } = require('./prompts/intent');
const { buildRelationPrompt } = require('./prompts/relation');
const { buildReminderPrompt } = require('./prompts/reminder');
const { buildReplySuggestionsPrompt, buildReplyFollowUpPrompt } = require('./prompts/reply-suggestions');
const { extractJsonArray } = require('./extract');

const TASKS = {
  // 意图识别：返回原始文本 + 解析出的数组，由调用方按 NO_TASK / JSON 分流
  intent: {
    opts: { temperature: 0.1 },
    buildPrompt: (ctx) => buildIntentPrompt(ctx),
    parse: (text) => ({ ok: true, text, array: extractJsonArray(text) })
  },
  relation: {
    opts: { temperature: 0.8 },
    buildPrompt: (ctx) => buildRelationPrompt(ctx.contact),
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
