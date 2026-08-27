// 小鹈鹕核心 — 统一路径解析
// 所有数据文件路径集中定义，避免每个脚本各拼一份路径。
'use strict';

const path = require('path');

// 打包模式：数据写入用户数据目录（XIAOTIHU_DATA_DIR）；开发模式：沿用项目根目录
function dataDir() {
  return process.env.XIAOTIHU_DATA_DIR || null;
}

function projectRoot() {
  return path.resolve(__dirname, '..', '..');
}

function baseDir() {
  return dataDir() || projectRoot();
}

function getPaths() {
  const b = baseDir();
  return {
    root: projectRoot(),
    dataDir: b,
    config: path.join(b, 'config.json'),
    inbox: path.join(b, 'inbox.jsonl'),
    pending: path.join(b, 'pending.jsonl'),
    batches: path.join(b, 'batches'),
    contacts: path.join(b, 'contacts'),
    logs: path.join(b, 'logs'),
    activityLog: path.join(b, 'activity.log'),
    watcherState: path.join(b, '.watcher-state.json'),
    watcherPid: path.join(b, '.watcher.pid'),
    remarkPending: path.join(b, 'remark-pending.json'),
    voicePending: path.join(b, 'voice-pending.json'),
    intentLastRun: path.join(b, 'intent-last-run.json'),
    intentState: path.join(b, 'intent-state.json'),
    intents: path.join(b, 'intents.json'),
    relationPushed: path.join(b, 'relation-pushed.json'),
    conversations: path.join(b, 'conversations.json'),
    unread: path.join(b, 'unread.json'),
    configToml: path.join(b, 'config.toml'),
    weixinCursor: path.join(b, 'weixin-cursor.json'),
    weixinContext: path.join(b, 'weixin-context.json')
  };
}

module.exports = { getPaths, dataDir, projectRoot, baseDir };
