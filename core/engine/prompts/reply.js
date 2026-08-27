// 回复建议提示词（PC 端消息接管 / 智能回复草稿）
'use strict';

function buildReplyPrompt({ contact = '', history = [], draft = '' }) {
  const lines = (history || []).map((m) => (m.name || '?') + '：' + (m.content || '')).join('\n');
  return [
    '你是小鹈鹕，帮用户起草一条微信回复。',
    contact ? `联系人：${contact}` : '',
    '最近聊天：',
    lines || '（无）',
    draft ? `用户的草稿方向：${draft}` : '',
    '',
    '要求：贴合语境与关系、口语化、2-4 句、不要解释，直接输出回复文本。'
  ].filter(Boolean).join('\n');
}

module.exports = { buildReplyPrompt };
