// 小鹈鹕 Agent — 队列 Worker
// 由小模型（意图识别/潜意识）写入 agent-tasks.jsonl 的具体任务，
// 这里由 DSH 大模型逐个拉取执行，并把执行过程记录到 Agent 任务列表。
'use strict';

const fs = require('fs');
const { log } = require('../lib/log');
const { getPaths } = require('../lib/paths');
const { readJson, writeJson } = require('../lib/store');
const { pushToUser } = require('../channels/weixin/push');
const { runTaskAndWait } = require('./tasks');
const queue = require('./queue');

const P = getPaths();

function buildQueueTaskPrompt(item) {
  const lines = [];
  lines.push('你是「小鹈鹕」的 DSH Agent。现在有一个系统安排的具体任务需要你执行。');
  lines.push('');
  lines.push(`任务类型：${item.type || 'task'}`);
  lines.push(`任务摘要：${item.summary || ''}`);
  if (item.detail) lines.push(`任务详情：${item.detail}`);
  if (item.source && item.source.contact) lines.push(`来源：${item.source.contact}`);
  lines.push('');
  lines.push('要求：');
  lines.push('1. 先理解任务，必要时读取本地文件、搜索资料或执行命令；');
  lines.push('2. 使用工具逐步完成，并把关键步骤展示出来；');
  lines.push('3. 最后用简洁中文汇报完成结果；如果无法完成，请说明原因。');
  return lines.join('\n');
}

// 关系维护类任务：DSH 生成问候语后，推送给用户确认
async function pushRelationResult(item, output, config) {
  const label = (item.payload && (item.payload.remark || item.payload.contact)) || item.source.contact || '联系人';
  const days = (item.payload && item.payload.days) || '';
  const msg = '🦩 关系维护提醒\n你和「' + label + '」已经 ' + days + ' 天没联系了。\n\n💬 DSH 建议：' + String(output || '').trim();
  const ok = await pushToUser(msg, { config });
  if (ok && item.payload && item.payload.contact) {
    let pushed = {};
    if (fs.existsSync(P.relationPushed)) pushed = readJson(P.relationPushed, {}) || {};
    pushed[item.payload.contact] = Date.now();
    writeJson(P.relationPushed, pushed);
    log('info', 'agent', `关系维护结果已推送：${label}`);
  } else {
    log('warn', 'agent', `关系维护结果推送失败：${label}`);
  }
  return ok;
}

async function processOne(config) {
  const item = queue.claimNext();
  if (!item) return null;
  const queueCfg = (config && config.agent && config.agent.queue) || {};
  const timeoutMs = queueCfg.timeoutMs || 300000;
  log('info', 'agent', `队列 Worker 拉取任务：${item.id} ${item.summary}`);
  try {
    const task = await runTaskAndWait(buildQueueTaskPrompt(item), {
      config,
      waitTimeoutMs: timeoutMs
    });
    if (task.status === 'completed') {
      queue.completeTask(item.id, { output: task.output, taskId: task.id });
      log('info', 'agent', `队列任务完成：${item.id} -> ${String(task.output || '').slice(0, 80)}`);
      if (item.type === 'relation') {
        await pushRelationResult(item, task.output, config);
      }
    } else {
      queue.failTask(item.id, task.error || 'DSH 执行失败', task.id);
      log('error', 'agent', `队列任务失败：${item.id} ${task.error || ''}`);
    }
    return item.id;
  } catch (e) {
    queue.failTask(item.id, e);
    log('error', 'agent', `队列 Worker 异常：${item.id} ${(e && e.message) || e}`);
    return item.id;
  }
}

// 每次只处理一个，避免多任务并发互相干扰；由 scheduler 按 intervalMs 调用。
async function drainOnce(config) {
  try {
    return await processOne(config);
  } catch (e) {
    log('error', 'agent', '队列 drainOnce 异常：' + ((e && e.message) || e));
    return null;
  }
}

module.exports = { processOne, drainOnce, buildQueueTaskPrompt };
