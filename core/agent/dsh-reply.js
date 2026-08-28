// 小鹈鹕 Agent — 通道对话自动回复
// 所有通道进来的对话都走 DSH harness 配置的 LLM 回复，
// 同时把该次执行记录为 Agent 任务，WebUI 可查看 DSH 的思考/工具调用过程。
'use strict';

const { runTaskAndWait, createTask } = require('./tasks');

function buildReplyPrompt({ message, history = [], channel = 'webui', contact = '', context = '' }) {
  const lines = [];
  lines.push('你是「小鹈鹕」，一个运行在用户本地的个人 AI 助手。');
  lines.push('你会使用 DSH harness 提供的大模型能力。可以读取本地文件、执行命令、调用工具来完成用户的要求。');
  lines.push('');
  lines.push('本地数据目录（用户问联系人/聊天记录/消息/某人说过什么时，优先只查这些位置）：');
  lines.push('- 联系人档案：contacts/*.json');
  lines.push('- 全量聊天流水：inbox.jsonl');
  lines.push('- 意图/待办：intents.json');
  lines.push('- 批次归档：batches/');
  lines.push('- 业务工作区：agent-workspace/');
  lines.push('搜索规则：');
  lines.push('- 禁止用 glob("**/*") 扫描整个项目根目录，禁止把 node_modules、.git、dist、logs、app、二进制/图片/视频文件作为搜索结果。');
  lines.push('- 搜索文件列表最多返回 100 条；结果很多时先做目录/类型/关键词过滤再展示。');
  lines.push('- 若只需联系人聊天记录，直接在 contacts/ 与 inbox.jsonl 中检索，不要读整个项目。');
  lines.push('');
  lines.push(`当前通道：${channel}${contact ? '（联系人：' + contact + '）' : ''}`);
  if (context) lines.push(`上下文：${context}`);
  lines.push('');

  if (history && history.length) {
    lines.push('以下是最近的对话历史（时间从早到晚）：');
    for (const h of history) {
      const role = h.role === 'bot' || h.role === 'assistant' ? '小鹈鹕' : h.role === 'system' ? '系统' : '用户';
      const text = String(h.text !== undefined ? h.text : h.content || '').trim();
      if (text) lines.push(`- ${role}：${text}`);
    }
    lines.push('');
  }

  lines.push(`用户最新消息：${String(message || '').trim()}`);
  lines.push('');
  lines.push('请直接回复用户这条消息。如果用户只是闲聊/提问，不需要调用任何工具；');
  lines.push('如果用户明确要求处理文件、执行命令或完成具体任务，则可以使用工具逐步完成，并在最后给出简明结果。');
  lines.push('回复请使用中文，保持自然、简洁。');
  return lines.join('\n');
}

/**
 * 非阻塞启动一条 DSH 对话回复任务，返回 task 对象（status 可能为 queued/running）。
 * 适合 WebUI：先返回 taskId，前端轮询任务事件实现流式展示。
 */
function startReplyTask({ message, history = [], channel = 'webui', contact = '', context = '', config, onFinish }) {
  const taskText = buildReplyPrompt({ message, history, channel, contact, context });
  return createTask(taskText, { config, onFinish });
}

/**
 * 使用 DSH Agent 回复一条通道消息。
 * @param {object} opts
 * @param {string} opts.message 最新用户消息
 * @param {Array} [opts.history] 最近对话历史 [{role,text}]
 * @param {string} [opts.channel] 通道名，如 weixin/webui
 * @param {string} [opts.contact] 联系人/会话标识
 * @param {string} [opts.context] 附加上下文
 * @param {object} [opts.config] 配置（用于读取 agent.reply 设置）
 * @returns {Promise<{ok:boolean, text:string, error?:string, taskId?:string}>}
 */
async function dshReply({ message, history = [], channel = 'webui', contact = '', context = '', config }) {
  const cfg = config || {};
  const replyCfg = (cfg.agent && cfg.agent.reply) || {};
  const taskText = buildReplyPrompt({ message, history, channel, contact, context });
  const task = await runTaskAndWait(taskText, {
    cwd: undefined,
    config,
    waitTimeoutMs: replyCfg.timeoutMs || 180000
  });

  if (task.status === 'completed') {
    const text = String(task.output || '').trim();
    if (!text) return { ok: false, error: 'DSH 返回了空回复', taskId: task.id };
    return { ok: true, text, taskId: task.id };
  }
  return { ok: false, error: task.error || 'DSH Agent 回复失败', taskId: task.id };
}

module.exports = { dshReply, startReplyTask, buildReplyPrompt };
