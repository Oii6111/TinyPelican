// 微信通道消息的轻量回复执行器
// 目标：
//  - 普通闲聊直连模型 API（不启动 DSH，最快）
//  - 疑似需要工具/文件/执行时，优先走 DSH WebUI 常驻进程（3080 /api RPC）
//  - 3080 不可用时回退 runDshTask headless
//  - 不走 agent/tasks 内存任务系统，不建 agentEvents
'use strict';

const { runDshTask } = require('./dsh-client');
const { chatCompletion } = require('../engine/client');
const { buildReplyPrompt } = require('./dsh-reply');
const dshWeb = require('./dsh-web-client');

// 简单启发式：命中这些词/场景就认为可能需要 DSH 的工具能力。
// 命中后会启动 DSH；不命中则走直连模型，速度快。
const TOOL_HINTS = [
  '查', '搜', '找', '读', '看', '打开', '创建', '新建', '生成',
  '修改', '编辑', '更新', '删除', '移除', '移动', '复制', '重命名',
  '下载', '上传', '运行', '执行', '启动', '停止', '安装', '卸载',
  '整理', '统计', '分析', '汇总', '对比', '检查', '测试', '调试',
  '文件', '目录', '文件夹', '路径', '命令行', '终端', '命令', '脚本',
  'python', 'node', 'powershell', 'bash', 'git', '网页', '链接',
  'excel', 'csv', 'json', 'yaml', '配置', '数据库', '接口', '报表'
];

function needsDsh(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  // 长文本更可能包含具体任务/需要工具
  if (t.length > 80) return true;
  return TOOL_HINTS.some((k) => t.includes(k.toLowerCase()));
}

function buildDirectMessages(history = [], message = '') {
  const messages = [{
    role: 'system',
    content: '你是「小鹈鹕」，一个运行在用户本地的个人 AI 助手。请直接、简洁、自然地回答用户。当前通过微信对话，不需要工具时不要提及文件/命令/工具。回复请使用中文。'
  }];
  for (const h of (history || []).slice(-12)) {
    const role = h.role === 'bot' ? 'assistant' : 'user';
    const text = String(h.text || '').trim();
    if (text) messages.push({ role, content: text });
  }
  messages.push({ role: 'user', content: String(message || '').trim() });
  return messages;
}

// 返回 { ok, text?, error?, mode: 'direct' | 'dsh-web' | 'dsh' }
async function answerWechatMessage({ message, history = [], userId = 'default', config = null } = {}) {
  const msg = String(message || '').trim();
  if (!msg) return { ok: false, error: '空消息', mode: 'direct' };

  if (!needsDsh(msg)) {
    const r = await chatCompletion(buildDirectMessages(history, msg), { config });
    if (r.ok) return { ok: true, text: r.text, mode: 'direct' };
    return { ok: false, error: r.error || '直连模型失败', mode: 'direct' };
  }

  // 优先走 DSH WebUI 常驻进程：不新拉 headless，速度快。
  const web = await dshWeb.ask({ userId, text: msg });
  if (web.ok) return { ok: true, text: web.text, mode: 'dsh-web' };

  // 3080 不可用时回退到一次性 headless，保证功能不中断。
  try {
    const prompt = buildReplyPrompt({
      message: msg,
      history,
      channel: 'weixin',
      contact: '',
      context: ''
    });
    const r = await runDshTask({ task: prompt, config });
    const text = String((r && r.text) || '').trim();
    if (r && r.ok && text) return { ok: true, text, mode: 'dsh' };
    return { ok: false, error: text ? 'DSH 返回空回复' : 'DSH 无输出', mode: 'dsh' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), mode: 'dsh' };
  }
}

module.exports = { answerWechatMessage, needsDsh, buildDirectMessages };
