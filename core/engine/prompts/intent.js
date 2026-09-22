// 意图识别提示词
//
// 关键点（都是踩过的坑）：
//  1. 必须给【当前时间】：否则「18 号说明天完成」在 22 号跑时仍会被当成未来待办；
//  2. 必须给【前文背景】：只看新增消息时，不知道「后来已经做完了 / 已经取消了」；
//  3. 相对时间一律按「那条消息自己的时间」换算，再和当前时间比较；
//  4. 已经完成/取消/过期的，输出 NO_TASK（不要制造假待办）。
'use strict';

function buildIntentPrompt({ chatText = '', contextText = '', sourceLabel = '', now = '' } = {}) {
  const lines = [
    '请分析下面这段聊天记录，识别其中需要小鹈鹕跟进的事情。',
    '',
    `当前时间：${now || '（未知）'}`,
    `来源联系人：${sourceLabel || '（未知）'}`
  ];

  if (contextText) {
    lines.push(
      '',
      '前文背景（更早的聊天，仅供理解上下文）：',
      contextText,
      '⚠️ 前文只用来判断「后面提到的事是否已经完成/取消/过期」，不要从前文里产出新的待办。'
    );
  }

  lines.push(
    '',
    '本次需要识别的消息（每行格式：消息时间 发送者: 内容）：',
    chatText,
    '',
    '意图类型：',
    '- todo：用户需要做的事情，但不一定现在安排时间，如“之后整理一下数据”',
    '- reminder：在某个时间点通知用户，可以是一次性或周期性，如“工作日16点提醒我打卡”',
    '- schedule：一段有开始/结束时间的活动，如“周五下午三点到五点开会”',
    '',
    '判断规则（必须遵守）：',
    '1. 先结合【当前时间】与【前文背景】逐条判断这件事现在是否仍然成立：已经做完、已经被取消、已经过期、或者只是随口一说的，一律不要输出。',
    '2. 相对时间（明天/后天/周五/下周一等）必须按**该条消息自己的时间**换算成绝对日期，再与当前时间比较；换算结果早于当前时间且没有证据表明仍未完成时，不要输出。',
    '3. 只要消息包含未来时间安排、待办、提醒、截止时间、委托、等待回复中的任意一种，且当前仍然成立，就必须输出 JSON，不能输出 NO_TASK。',
    '4. 别人明确告诉“你需要在 / 你要 / 你得 / 你必须 / 记得 / 别忘了”等，是给用户的安排/指令，必须识别。',
    '5. 例如“明早八点你需要在医院签到，下午四点需要签退” → 拆成 schedule 或 reminder。',
    '6. 需要 AI 帮用户完成的事情统一识别为 todo，不要创建“AI任务”类型；是否调用 DSH 放在 execution.mode 中。',
    '7. 只有明确要求 Agent 现在执行，或明确指定未来由 Agent 执行时，execution.mode 才能是 dsh；普通待办为 manual。',
    '8. reminder 由系统在指定时间提醒用户，execution.mode 必须是 system，不要给 dsh action；周期提醒必须给 recurrence.cron。',
    '9. schedule 只代表一段时间活动，不调用 Agent。',
    '10. 一条消息包含多个独立时间安排时，可以拆成多条意图。',
    '11. detail 里写清判断依据（原文片段）；如果这件事已经过期但你认为仍可能需要跟进，把 expired 设为 true，并降低 confidence。',
    '',
    '只输出 NO_TASK 或 JSON 数组，每个对象格式：',
    '{"type":"todo|reminder|schedule","summary":"一句话标题","detail":"关键背景/原文摘录","deadline":"开始时间或截止时间的原文表达或null","endAt":"日程结束时间原文表达或null","expired":false,"execution":{"mode":"manual|system|dsh","capability":"file_edit|web_research|data_organize|message|other","instruction":"执行说明","inputs":{}},"recurrence":{"cron":"0 16 * * 1-5","label":"工作日每天16:00"},"people":["涉及的人"],"priority":"high|medium|low","confidence":0.85,"reason":"判定理由"}',
    '不要解释，不要 Markdown 代码块。'
  );

  return lines.join('\n');
}

module.exports = { buildIntentPrompt };
