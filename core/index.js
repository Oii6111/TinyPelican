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
const { readContact } = require('./memory/stores/contacts');
const { dshReply } = require('./agent/dsh-reply');
const agentQueue = require('./agent/queue');
const { drainOnce } = require('./agent/queue-runner');

const RESTART_EXIT_CODE = 42;
const PORT = parseInt(process.env.V3_PORT || '18791', 10);

function recentHistory(contact, max = 12) {
  try {
    const doc = readContact(contact);
    const msgs = (doc.messages || []).slice(-max);
    return msgs.map((m) => ({
      role: 'user',
      text: `${m.ts || ''} ${m.name || ''}: ${m.content || ''}`
    }));
  } catch {
    return [];
  }
}

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
  const queueCfg = (cfg.agent && cfg.agent.queue) || {};
  if (queueCfg.enabled !== false) {
    agentQueue.resetStale();
    scheduler.register({
      name: 'agent-queue',
      intervalMs: queueCfg.intervalMs || 10000,
      run: async () => {
        // 每次最多处理 3 个，避免长时间阻塞主线程
        for (let i = 0; i < 3; i++) {
          const done = await drainOnce({ config: cfg });
          if (!done) break;
        }
      },
      immediate: true
    });
  }

  const triggerIntent = () =>
    runIntentExtraction({ config: cfg }).catch((e) =>
      log('error', 'intent', '意图识别异常：' + ((e && e.message) || e)));

  // 心跳式意图识别：配置 intent.scanIntervalMs > 0 后按固定周期扫描
  const intentScanMs = (cfg.intent && cfg.intent.scanIntervalMs) || 0;
  if (intentScanMs > 0) {
    scheduler.register({
      name: 'intent-scan',
      intervalMs: intentScanMs,
      run: triggerIntent,
      immediate: false
    });
  }

  scheduler.start();

  let wechat = null;
  const handleChannelMessage = async (m) => {
    const replyCfg = (cfg.agent && cfg.agent.reply) || {};
    const contact = m.name || m.from || 'inbox';
    const history = recentHistory(contact, replyCfg.maxHistory || 12);

    const added = ingestMessages([m], m.name, { unread: true });
    if (added) triggerIntent();

    if (replyCfg.enabled === false || !m.content) return;
    try {
      const r = await dshReply({
        message: m.content,
        history,
        channel: m.channel || 'channel',
        contact,
        config: cfg
      });
      if (r.ok && r.text && wechat) {
        await wechat.send({ to: m.from, text: r.text, contextToken: m.contextToken || '' });
      } else if (!r.ok) {
        log('warn', 'agent', `自动回复失败（${m.channel || 'unknown'}）：${r.error || ''}`);
      }
    } catch (e) {
      log('error', 'agent', '自动回复异常：' + ((e && e.message) || e));
    }
  };

  wechat = new WeChatChannel({
    config: cfg,
    onMessage: (m) => {
      handleChannelMessage(m).catch((e) =>
        log('error', 'agent', '通道消息处理异常：' + ((e && e.message) || e)));
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
