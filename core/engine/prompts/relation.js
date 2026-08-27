// 关系维护建议提示词
'use strict';

function buildRelationPrompt(contact) {
  const recent = (contact.messages || []).slice(-3)
    .map((m) => (m.name || '?') + '：' + (m.content || '[' + (m.type || 'text') + ']')).join('\n');
  const profile = contact.profile || {};
  return [
    '为维护人际关系，给微信联系人「' + (contact.remark || contact.name) + '」生成一条发给TA的问候消息。',
    '背景：你们已经 ' + contact.days + ' 天没联系了。',
    '最近聊天：',
    recent,
    profile['近况'] ? 'TA的近况：' + profile['近况'] : '',
    '要求：一条自然、简短（50字内）、口语化的微信问候，能自然开启话题。只输出问候语本身，不要解释。'
  ].filter(Boolean).join('\n');
}

module.exports = { buildRelationPrompt };
