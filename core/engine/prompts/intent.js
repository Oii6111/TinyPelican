// 意图识别提示词
'use strict';

function buildIntentPrompt(chatText, sourceLabel) {
  return [
    '请分析下面这段聊天记录，识别其中需要小鹈鹕跟进的事情。',
    '',
    '意图类型：',
    '- todo：用户需要做的事情，但不一定现在安排时间，如“之后整理一下数据”',
    '- reminder：在某个时间点通知用户，可以是一次性或周期性，如“工作日16点提醒我打卡”',
    '- schedule：一段有开始/结束时间的活动，如“周五下午三点到五点开会”',
    '',
    '判断规则（必须遵守）：',
    '1. 只要消息包含未来时间安排、待办、提醒、截止时间、委托、等待回复中的任意一种，就必须输出 JSON，不能输出 NO_TASK。',
    '2. 别人明确告诉“你需要在 / 你要 / 你得 / 你必须 / 记得 / 别忘了”等，是给用户的安排/指令，必须识别。',
    '3. 例如“明早八点你需要在医院签到，下午四点需要签退” → 拆成 schedule 或 reminder。',
    '4. 需要 AI 帮用户完成的事情统一识别为 todo，不要创建“AI任务”类型；是否调用 DSH 放在 execution.mode 中。',
    '5. 只有明确要求 Agent 现在执行，或明确指定未来由 Agent 执行时，execution.mode 才能是 dsh；普通待办为 manual。',
    '6. reminder 由系统在指定时间提醒用户，execution.mode 必须是 system，不要给 dsh action；周期提醒必须给 recurrence.cron。',
    '7. schedule 只代表一段时间活动，不调用 Agent。',
    '8. 纯闲聊、寒暄、过去事实、观点解释、已完成的陈述 → 输出 NO_TASK。',
    '9. 一条消息包含多个独立时间安排时，可以拆成多条意图。',
    '',
    '来源：' + sourceLabel,
    '聊天记录：',
    chatText,
    '',
    '只输出 NO_TASK 或 JSON 数组，每个对象格式：',
    '{"type":"todo|reminder|schedule","summary":"一句话标题","detail":"关键背景/原文摘录","deadline":"开始时间或截止时间的原文表达或null","endAt":"日程结束时间原文表达或null","execution":{"mode":"manual|system|dsh","capability":"file_edit|web_research|data_organize|message|other","instruction":"执行说明","inputs":{}},"recurrence":{"cron":"0 16 * * 1-5","label":"工作日每天16:00"},"people":["涉及的人"],"priority":"high|medium|low","confidence":0.85,"reason":"判定理由"}',
    '不要解释，不要 Markdown 代码块。'
  ].join('\n');
}

module.exports = { buildIntentPrompt };
