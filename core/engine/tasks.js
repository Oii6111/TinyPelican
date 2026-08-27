// 小鹈鹕核心 — 任务注册表
// 每个任务 = 提示词构造 + 输出解析；业务代码只按任务名调用。
'use strict';

const { buildIntentPrompt } = require('./prompts/intent');
const { buildRelationPrompt } = require('./prompts/relation');
const { buildReminderPrompt } = require('./prompts/reminder');
const { buildReplyPrompt } = require('./prompts/reply');
const { extractJsonArray } = require('./extract');

const TASKS = {
  // 意图识别：返回原始文本 + 解析出的数组，由调用方按 NO_TASK / JSON 分流
  intent: {
    opts: { temperature: 0.1 },
    buildPrompt: (ctx) => buildIntentPrompt(ctx.chatText, ctx.sourceLabel),
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
  reply: {
    opts: { temperature: 0.8 },
    buildPrompt: (ctx) => buildReplyPrompt(ctx),
    parse: (text) => ({ ok: true, text })
  }
};

function getTask(name) {
  return TASKS[name] || null;
}

module.exports = { TASKS, getTask };
