// 小鹈鹕专用 DSH 插件：把 Agent 会话事件以 JSONL 形式输出到 stdout。
// 这样小鹈鹕的 Node 客户端可以像 DSH WebUI 一样实时看到
// 思考/消息/工具调用/工具结果/步骤/turn 等过程。
// 插件自带 node_modules/@deepseek-ai/schemastery junction，保证从任意路径加载都能解析。
import z from '@deepseek-ai/schemastery';

const name = 'xiaotihu-event-stream';
const inject = [];
const Config = z.object({});

const STREAM_MARKER = '@@DSH_EVENT@@';
const INTERESTING_EVENTS = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'assistant/chunk',
  'assistant/message',
  'tool/call',
  'tool/result',
  'tool/code-dispatch',
  'user/message',
  'approval/asked',
  'approval/decided',
  'todo/write',
  'plan/mode',
  'goal/change',
  'subagent/descriptor'
]);

function apply(ctx) {
  const out = process.stdout;
  const writeEvent = (session, event) => {
    if (!INTERESTING_EVENTS.has(event.type)) return;
    const line = STREAM_MARKER + ' ' + JSON.stringify({
      type: event.type,
      seq: event.seq,
      time: event.time,
      session: String(session && session.id ? session.id : ''),
      data: event.data
    });
    out.write(line + '\n');
  };

  // session/event 是 DSH 的持久化事件总线；headless runner 和 WebUI 都基于它。
  ctx.on('session/event', writeEvent);
}

export { Config, apply, inject, name };
