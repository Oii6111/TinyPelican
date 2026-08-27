// 意图识别提示词
'use strict';

function buildIntentPrompt(chatText, sourceLabel) {
  return [
    '请分析下面这段聊天记录，识别其中需要小鹈鹕跟进的事情。',
    '',
    '意图类型：',
    '- task：需要执行的任务/委托，如“帮我查一下”',
    '- deadline：有明确截止时间的任务，如“下周一之前交”',
    '- schedule：日程/会议/约会/个人时间安排，如“周五下午三点开会”',
    '- reminder：事项提醒/待办/自我提醒，如“记得明天买试剂”',
    '- waiting_reply：有人在等回复，如“你昨天问我的事有结果了吗”',
    '',
    '判断规则（必须遵守）：',
    '1. 只要消息包含未来时间安排、待办、提醒、截止时间、委托、等待回复中的任意一种，就必须输出 JSON，不能输出 NO_TASK。',
    '2. 别人明确告诉“你需要在 / 你要 / 你得 / 你必须 / 记得 / 别忘了”等，是给用户的安排/指令，必须识别。',
    '3. 例如“明早八点你需要在医院签到打卡上班，下午四点需要签退” → 必须识别为 schedule 或 reminder。',
    '4. 纯闲聊、寒暄、过去事实、观点解释、已完成的陈述 → 输出 NO_TASK。',
    '5. 一条消息包含多个独立时间安排时，可以拆成多条意图。',
    '',
    '来源：' + sourceLabel,
    '聊天记录：',
    chatText,
    '',
    '只输出 NO_TASK 或 JSON 数组，每个对象格式：',
    '{"type":"task|deadline|schedule|reminder|waiting_reply","summary":"一句话标题","detail":"关键背景/原文摘录","deadline":"原文时间表达或null","people":["涉及的人"],"priority":"high|medium|low","confidence":0.85,"reason":"判定理由"}',
    '不要解释，不要 Markdown 代码块。'
  ].join('\n');
}

module.exports = { buildIntentPrompt };
