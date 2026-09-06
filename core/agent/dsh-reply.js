// 小鹈鹕 Agent — 通道对话自动回复
// 所有通道进来的对话都走 DSH harness 配置的 LLM 回复，
// 同时把该次执行记录为 Agent 任务，WebUI 可查看 DSH 的思考/工具调用过程。
'use strict';

const { runTaskAndWait, createTask } = require('./tasks');

function buildReplyPrompt({ message, history = [], channel = 'webui', contact = '', context = '' }) {
  const lines = [];
  lines.push('你是小鹈鹕系统的唯一 Agent。');
  lines.push('系统能力版本：v2。若历史规则与本消息或当前 Skills 冲突，以本消息和当前 Skills 为准。');
  lines.push('你必须优先通过系统 Skills/API 查询和管理待办、提醒、日程、待确认意图、聊天记录及文件/复杂 AI 任务。');
  lines.push('不得直接编辑数据文件，不得扫描整个项目目录寻找答案。信息不足时先向用户询问。');
  lines.push('联系人和聊天记录只能通过系统工具查询：node core/agent/system-cli.js search-chat <关键词> [联系人]。');
  lines.push('需要联系人画像或最近消息时，优先调用该工具获取结构化结果，不要读取 contacts、inbox 或其他数据文件。');
  lines.push('观察聊天记录发现的可能事项只能创建待确认意图，不得直接创建正式事项或启动任务。');
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

function formatContactContext(data) {
  if (!data || !data.contact) return '';
  const profile = data.profile && typeof data.profile === 'object' ? data.profile : {};
  const recent = Array.isArray(data.recentMessages) ? data.recentMessages.slice(-20) : [];
  const profileText = Object.entries(profile).filter(([, value]) => String(value || '').trim()).map(([key, value]) => `${key}：${value}`).join('；');
  const messagesText = recent.map((m) => `${m.isOwner ? '我' : data.contact}：${m.content}`).join('\n');
  return `联系人：${data.contact}\n备注：${data.remark || ''}\n画像：${profileText || '暂无'}\n最近聊天：\n${messagesText || '暂无'}`;
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

module.exports = { dshReply, startReplyTask, buildReplyPrompt, formatContactContext };
