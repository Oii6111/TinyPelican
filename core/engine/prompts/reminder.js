// 提醒文案提示词
'use strict';

function buildReminderPrompt(intent) {
  return [
    '请根据以下事项生成一条微信提醒消息。',
    '要求：口语化、自然、不超过50字、不要解释、不要JSON、不要NO_TASK，直接输出提醒文本。',
    '',
    `事项：${intent.summary}`,
    intent.dueText ? `时间：${intent.dueText}` : '',
    intent.source && intent.source.contact ? `来源：${intent.source.contact}` : '',
    '',
    '提醒消息：'
  ].filter(Boolean).join('\n');
}

module.exports = { buildReminderPrompt };
