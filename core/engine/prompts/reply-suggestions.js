// 回复建议提示词：为私聊生成多组「连贯消息方案」
// 每组方案 = 按发送顺序排列的 1~N 条消息（多数情况 1~2 条短消息，必要时才发小作文）。
//
// 视角是这个提示词最容易出错的地方：聊天记录必须按「你（用户）/ 对方（联系人）」标注，
// 否则模型分不清谁说了什么，会替对方写话。chatDb 的历史行发件人字段是 sender，
// 旧数据/搜索结果里是 name，这里统一用 speakerOf() 解析。
'use strict';

// 发件人昵称：database 行用 sender，legacy/搜索结果用 name
function speakerOf(m) {
  if (!m) return '';
  return String(m.name || m.sender || m.senderName || '').trim();
}

// 消息正文：非文本消息用 [图片] / [语音] 之类的占位，别丢了上下文
function messageText(m) {
  const content = String((m && m.content) || '').trim();
  if (content) return content;
  const type = String((m && m.type) || '').trim();
  return type && type !== 'text' ? `[${type}]` : '';
}

// max = 保留最近多少条；selfNames = 用户自己的昵称（含 selfNicknames）
function formatHistory(messages, { max = 24, selfNames = [] } = {}) {
  const selfSet = new Set((Array.isArray(selfNames) ? selfNames : [selfNames]).map((n) => String(n || '').trim()).filter(Boolean));
  const rows = [];
  for (const m of (messages || []).slice(-max)) {
    const text = messageText(m);
    if (!text) continue;
    const name = speakerOf(m);
    // 知道自己的昵称时用角色标注（最不容易被模型理解错）；不知道就退回昵称原文
    const who = selfSet.size ? (selfSet.has(name) ? '你' : '对方') : (name || '?');
    rows.push(`${who}：${text}`);
  }
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

function normalizeLatest(latestMessage) {
  if (!latestMessage) return { text: '', speaker: '', isSelf: false };
  if (typeof latestMessage === 'string') {
    return { text: String(latestMessage || '').trim(), speaker: '', isSelf: false };
  }
  return {
    text: String(latestMessage.text || '').trim(),
    speaker: String(latestMessage.speaker || '').trim(),
    isSelf: !!latestMessage.isSelf
  };
}

// 联系人 / 画像 / 聊天记录 / 最新一条消息 —— 首轮建议和“接着写剩下的”共用这段上下文
function buildContextLines({
  contact = '',
  remark = '',
  profile = {},
  socialGoal = '',
  history = [],
  olderConversationContext = [],
  latestMessage = null,
  selfNicknames = []
}) {
  const selfNames = (Array.isArray(selfNicknames) ? selfNicknames : [selfNicknames])
    .map((n) => String(n || '').trim())
    .filter(Boolean);
  const knownViewpoint = selfNames.length > 0;

  const historyText = formatHistory(history, { max: 24, selfNames });
  const olderText = formatHistory(olderConversationContext, { max: 8, selfNames });
  const profileText = filterProfile(profile);

  const latest = normalizeLatest(latestMessage);
  const latestText = latest.text || '（无）';
  const latestRole = latest.isSelf ? '你（用户）' : '对方（联系人）';

  const lines = [
    '你是用户的微信回复助手。用户刚复制了一段微信聊天，你要替他准备下一次回复。',
    '',
    '【视角】你写的每一条建议都是「用户本人」发给联系人的话：',
    knownViewpoint
      ? `- 聊天记录里的「你」= 用户本人（昵称：${selfNames.join('、')}），「对方」= 联系人（${contact}）；`
      : '- 聊天记录里发件人是「我」或用户自己的昵称的一方是用户本人；',
    knownViewpoint
      ? '- 「你」说的话是历史记录，不要重复；建议要从「你」的角度接着往下说。'
      : '- 建议只写用户作为回复方该说的话，绝不要替对方发言。',
    `- 严禁把对方（${contact}）的口吻、承诺或立场写成用户的回复；也不要写成旁白或转述。`,
    '',
    `联系人：${contact}`,
    `备注：${remark || '（无）'}`
  ];
  if (socialGoal) lines.push(`社交目标：${socialGoal}`);
  lines.push(
    '',
    '联系人画像：',
    profileText || '（无）',
    '',
    '最近聊天（按时间正序，「你」= 用户本人，「对方」= 联系人）：',
    historyText || '（无）'
  );
  if (olderText) {
    lines.push('', '更早的相关聊天片段：', olderText);
  }
  lines.push(
    '',
    `最近一条消息（来自${latestRole}${latest.speaker ? ` ${latest.speaker}` : ''}）：`,
    latestText
  );

  return lines;
}

function hintLines(userHint) {
  const hintText = String(userHint || '').trim();
  if (!hintText) return [];
  return [
    '',
    '用户这次希望表达的想法（必须优先满足，且仍然要由用户的身份说出来）：',
    hintText
  ];
}

function avoidLines(avoid) {
  const avoidList = (Array.isArray(avoid) ? avoid : []).map((t) => String(t || '').trim()).filter(Boolean);
  if (!avoidList.length) return [];
  return [
    '',
    '以下说法已经给过用户，请换一批不同的说法，不要重复：',
    ...avoidList.map((t) => `- ${t}`)
  ];
}

function buildReplySuggestionsPrompt({
  userHint = '',
  avoid = [],
  planCount = 3,
  maxMessagesPerPlan = 3,
  maxMessageChars = 40,
  ...ctx
}) {
  const lines = buildContextLines(ctx);
  const contact = ctx.contact || '';

  lines.push(...hintLines(userHint));
  lines.push(...avoidLines(avoid));

  lines.push(
    '',
    '要求：',
    '1. 先判断这一轮需要发几条消息：多数情况下 1~2 条简短消息最自然；只有必须完整说明一件事（像写小作文）时，才用一条较长的消息。',
    `2. 给出 ${planCount} 组不同风格的方案，每组包含 1~${maxMessagesPerPlan} 条消息，并严格按发送顺序排列。`,
    '3. 同一组里的多条消息要像真人连着发的一样：先回应、再补充、再追问，语气自然连贯；不要出现「第一」「第二」这类书面编号，也不要把多句话挤成一条长消息。',
    `4. 每条消息尽量短（不超过 ${maxMessageChars} 个字），口语化，像真人微信聊天。`,
    '5. 不要解释、不要用 Markdown、不要堆砌 emoji。',
    '6. 不要替用户做无法确认的承诺，不要编造事实。',
    `7. 全部建议都必须能由「用户」直接发给「${contact}」；视角错了就重写。`,
    '8. 只输出合法 JSON 数组。',
    '',
    '输出格式（必须使用双引号；messages 是这一组按顺序发送的消息）：',
    '[',
    '  { "tone": "自然", "messages": ["第一条", "第二条"] },',
    '  { "tone": "关心", "messages": ["一条就够"] },',
    '  { "tone": "简洁", "messages": ["好的", "明天见"] }',
    ']'
  );

  return lines.join('\n');
}

// 用户已经按这组方案发出了前几条，现在只想把「剩下的几条」重写：
// 必须把已发内容带进上下文，否则续写会和已发出的消息割裂。
function buildReplyFollowUpPrompt({
  sent = [],
  userHint = '',
  avoid = [],
  maxMessagesPerPlan = 4,
  maxMessageChars = 40,
  ...ctx
}) {
  const lines = buildContextLines(ctx);
  const contact = ctx.contact || '';
  const sentList = (Array.isArray(sent) ? sent : []).map((t) => String(t || '').trim()).filter(Boolean);

  lines.push(
    '',
    '用户已经开始按一组方案回复了，下面这几条是他「刚刚发出去」的消息（按发送顺序）：',
    ...sentList.map((t, i) => `${i + 1}. ${t}`),
    '',
    '现在需要重写「接下来还要发的那几条」。'
  );

  lines.push(...hintLines(userHint));
  lines.push(...avoidLines(avoid));

  lines.push(
    '',
    '要求：',
    '1. 必须在已发内容之后接着往下说：不要重复已发过的信息，也不要和已发内容自相矛盾。',
    `2. 给出 1 组方案，包含 1~${maxMessagesPerPlan} 条消息，按发送顺序排列；能一句收尾就一句，别硬凑。`,
    '3. 语气要和已发的几条连贯，像同一个人连着发出来的。',
    `4. 每条消息尽量短（不超过 ${maxMessageChars} 个字），口语化。`,
    '5. 不要解释、不要用 Markdown、不要堆砌 emoji，不要出现「第一」「第二」这类书面编号。',
    `6. 必须能由「用户」直接发给「${contact}」；不要替对方说话。`,
    '7. 只输出合法 JSON 数组，只要一组。',
    '',
    '输出格式（必须使用双引号）：',
    '[',
    '  { "tone": "自然", "messages": ["接下来的第一条", "接下来的第二条"] }',
    ']'
  );

  return lines.join('\n');
}

module.exports = { buildReplySuggestionsPrompt, buildReplyFollowUpPrompt, speakerOf };
