// 小鹈鹕核心 — 常驻入口
// 拉起 HTTP 服务、剪贴板监听、微信通道、进程内定时调度；退出码 42 表示请求重启（由 launcher 接管）。
'use strict';

const { loadConfig } = require('./lib/config');
const { log } = require('./lib/log');
const { startHeartbeat, stopHeartbeat } = require('./status');
const { createServer } = require('./server');
const { Scheduler } = require('./remind/scheduler');
const { runReminders } = require('./remind/runner');
const { runRelationCheck } = require('./memory/relations');
const { runIntentExtraction } = require('./engine/intent-runner');
const { ClipboardWatcher } = require('./capture/clipboard');
const { WeChatChannel } = require('./channels/weixin/channel');
const { ingestMessages } = require('./ingest/pipeline');

const RESTART_EXIT_CODE = 42;
const PORT = parseInt(process.env.V3_PORT || '18791', 10);

async function main() {
  const cfg = loadConfig();

  const server = createServer({
    config: cfg,
    onRestart: () => {
      log('info', 'core', '收到重启请求，即将重启核心');
      setTimeout(() => process.exit(RESTART_EXIT_CODE), 600);
    }
  });
  server.listen(PORT, '127.0.0.1', () => {
    log('info', 'core', `小鹈鹕核心已启动: http://127.0.0.1:${PORT}`);
  });

  startHeartbeat((cfg.heartbeat && cfg.heartbeat.intervalSec) || 30);

  const scheduler = new Scheduler();
  scheduler.register({
    name: 'remind',
    intervalMs: 15 * 60 * 1000,
    run: () => runReminders({ config: cfg }),
    immediate: true
  });
  scheduler.register({
    name: 'relation',
    intervalMs: 24 * 60 * 60 * 1000,
    run: () => runRelationCheck({ config: cfg })
  });
  scheduler.start();

  const triggerIntent = () =>
    runIntentExtraction({ config: cfg }).catch((e) =>
      log('error', 'intent', '意图识别异常：' + ((e && e.message) || e)));

  const wechat = new WeChatChannel({
    config: cfg,
    onMessage: (m) => {
      const added = ingestMessages([m], m.name, { unread: true });
      if (added) triggerIntent();
    }
  });
  await wechat.connect();

  const watcher = new ClipboardWatcher({
    config: cfg,
    onBatch: ({ msgs, contact }) => {
      const added = ingestMessages(msgs, contact);
      if (added) triggerIntent();
    }
  });
  const captureCfg = cfg.capture || {};
  if (captureCfg.enabled) {
    watcher.start();
  } else {
    log('info', 'capture', '剪贴板捕获未启用（可在设置页开启）');
  }

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    log('info', 'core', '正在停止...');
    watcher.stop();
    wechat.stop();
    scheduler.stop();
    stopHeartbeat();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[core] 启动失败', e);
    process.exit(1);
  });
}
