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
const { answerWechatMessage } = require('./agent/wechat-reply');
const { historyEventList } = require('./agent/event-utils');
const mainSession = require('./agent/main-session');
const conversations = require('./memory/stores/conversations');
const { generateReplySuggestions } = require('./reply/suggestions');
const agentQueue = require('./agent/queue');
const { drainOnce } = require('./agent/queue-runner');

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
    intervalMs: 60 * 1000,
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

  // 确保 DSH WebUI（默认 3080）可用；不可用则由小鹈鹕自动拉起。
  try {
    const webStart = await mainSession.ensureReady();
    log('info', 'agent', webStart && webStart.started
      ? '已自动启动 DSH WebUI（3080）'
      : 'DSH WebUI（3080）已就绪');
  } catch (e) {
    log('warn', 'agent', 'DSH WebUI 启动/探测失败：' + String((e && e.message) || e));
  }

  let wechat = null;
  const handleChannelMessage = async (m) => {
    const replyCfg = (cfg.agent && cfg.agent.reply) || {};
    if (replyCfg.enabled === false || !m.content || !wechat) return;

    // 微信通道消息定位为「主对话」：长期保存在 conversations，
    // 并拥有稳定 DSH Web 会话 agent:main:weixin:<user>；不写入联系人记忆归档。
    const session = 'agent:main:weixin:' + (m.from || 'default');
    conversations.append(session, { role: 'user', text: m.content });
    const full = conversations.get(session);
    const history = full.slice(-20, -1).map((e) => ({
      role: e.role === 'bot' ? 'bot' : 'user',
      text: e.text
    }));

    let r = null;
    try {
      // 优先走 DSH WebUI 常驻会话，微信拥有自己的长期主会话。
      r = await mainSession.send({ sessionKey: session, message: m.content, history });
    } catch (e) {
      log('error', 'agent', '微信主会话发送异常：' + String((e && e.message) || e));
    }

    // DSH Web 不可用时降级：headless 或直连模型，保证微信仍能收到回复。
    if (!r || !r.ok) {
      try {
        r = await answerWechatMessage({
          message: m.content,
          history,
          userId: m.from || 'default',
          config: cfg
        });
      } catch (e) {
        log('error', 'agent', '微信回复降级异常：' + String((e && e.message) || e));
      }
    }

    if (r && r.ok && r.text) {
      const text = r.text;
      conversations.append(session, {
        role: 'bot',
        text,
        agentEvents: historyEventList((r && r.events) || [])
      });
      await wechat.send({ to: m.from, text, contextToken: m.contextToken || '' });
      log('info', 'weixin', `微信 Agent 回复成功（${r.mode || 'unknown'}）`);
    } else {
      log('warn', 'agent', `微信 Agent 回复失败：${(r && r.error) || '未知错误'}`);
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
    onBatch: ({ msgs, contact, targetWindow }) => {
      const added = ingestMessages(msgs, contact);
      if (added) triggerIntent();
      // 回复建议：先归档再生成，失败不影响归档
      generateReplySuggestions({ contact, targetWindow, config: cfg })
        .catch((e) => log('warn', 'reply', '回复建议生成失败：' + String((e && e.message) || e)));
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
    mainSession.stop();
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
