// 回复建议提示词：为私聊生成 3 条不同风格的回复建议
'use strict';

function formatHistory(messages, max = 24) {
  const rows = (messages || []).slice(-max).map((m) => {
    const name = String(m.name || '?');
    const content = String(m.content || '').trim();
    return `${name}：${content}`;
  });
  return rows.join('\n');
}

function filterProfile(profile = {}) {
  const lines = [];
  for (const [k, v] of Object.entries(profile)) {
    const val = String(v || '').trim();
    if (!val || val === '未知') continue;
    lines.push(`${k}：${val}`);
  }
  return lines.join('\n');
}

function buildReplySuggestionsPrompt({
  contact = '',
  remark = '',
  profile = {},
  history = [],
  latestMessage = '',
  selfNicknames = [],
  maxOptionChars = 120
}) {
  const me = Array.isArray(selfNicknames) && selfNicknames.length ? selfNicknames[0] : '我';
  const historyText = formatHistory(history, 24);
  const profileText = filterProfile(profile);

  let latestText = '';
  let latestSpeaker = '';
  let latestIsSelf = false;
  if (typeof latestMessage === 'string') {
    latestText = String(latestMessage || '').trim();
  } else if (latestMessage && typeof latestMessage === 'object') {
    latestText = String(latestMessage.text || '').trim();
    latestSpeaker = String(latestMessage.speaker || '').trim();
    latestIsSelf = !!latestMessage.isSelf;
  }
  if (!latestText) latestText = '（无）';
  const latestRole = latestIsSelf ? '你' : '对方';

  return [
    '你是用户的微信回复助手。',
    '请根据联系人画像、双方关系和最近聊天，为用户生成下一句话的回复建议。',
    '',
    `联系人：${contact}`,
    `备注：${remark || '（无）'}`,
    '',
    '联系人画像：',
    profileText || '（无）',
    '',
    '最近聊天：',
    historyText || '（无）',
    '',
    `最近一条消息（来自${latestRole}${latestSpeaker ? '：' + latestSpeaker : ''}，本会话中“${me}”代表你）：`,
    latestText,
    '',
    '要求：',
    '1. 生成 3 条不同风格的回复；',
    '2. 分别偏向“自然”“关心”“简洁”；',
    '3. 必须口语化，像真人微信聊天；',
    '4. 不要解释；',
    '5. 不要使用 Markdown；',
    '6. 不要替用户做无法确认的承诺；',
    `7. 单条回复最多 ${maxOptionChars} 个中文字符；`,
    '8. 只输出合法 JSON 数组。',
    '',
    '输出格式（必须使用双引号）：',
    '[',
    '  { "tone": "自然", "text": "回复内容" },',
    '  { "tone": "关心", "text": "回复内容" },',
    '  { "tone": "简洁", "text": "回复内容" }',
    ']'
  ].join('\n');
}

module.exports = { buildReplySuggestionsPrompt };
