// 小鹈鹕核心 — 常驻入口
// 拉起 HTTP 服务、剪贴板监听、微信通道、进程内定时调度；退出码 42 表示请求重启（由 launcher 接管）。
'use strict';

require('./lib/startup').initializeRuntime();

const { loadConfig } = require('./lib/config');
const { log } = require('./lib/log');
const { startHeartbeat, stopHeartbeat } = require('./status');
const { createServer } = require('./server');
const { Scheduler } = require('./remind/scheduler');
const { runReminders } = require('./remind/runner');
const { runRelationCheck } = require('./memory/relations');
const { requestIntentExtraction } = require('./engine/intent-runner');
const { ClipboardWatcher } = require('./capture/clipboard');
const { WeChatChannel } = require('./channels/weixin/channel');
const { publicAttachment } = require('./channels/weixin/media');
const { prepareReply, deliverReply } = require('./channels/weixin/delivery');
const { ingestMessages, ingestCapturedBatch, describeTarget } = require('./ingest/pipeline');
const { answerWechatMessage } = require('./agent/wechat-reply');
const { formatAttachmentContext, WEIXIN_MEDIA_INSTRUCTIONS } = require('./agent/dsh-reply');
const { historyEventList } = require('./agent/event-utils');
const mainSession = require('./agent/main-session');
const conversations = require('./memory/stores/conversations');
const { generateReplySuggestions } = require('./reply/suggestions');
const { notifyUser } = require('./notify');
const chatDb = require('./memory/chat-db');
const agentQueue = require('./agent/queue');
const { drainOnce } = require('./agent/queue-runner');
const { EmailService } = require('./email/service');

const RESTART_EXIT_CODE = 42;
const PORT = parseInt(process.env.V3_PORT || '18791', 10);

async function main() {
  const cfg = loadConfig();
  const emailService = new EmailService({ config: cfg, resolveContact: (address) => {
    return chatDb.findMembersByEmail(address);
  } });

  const server = createServer({
    config: cfg,
    emailService,
    onRestart: () => {
      log('info', 'core', '收到重启请求，即将重启核心');
      setTimeout(() => process.exit(RESTART_EXIT_CODE), 600);
    }
  });
  server.listen(PORT, '127.0.0.1', () => {
    log('info', 'core', `小鹈鹕核心已启动: http://127.0.0.1:${PORT}`);
  });
  // 端口被占用是最容易踩、又最难查的一种启动失败：核心以前会直接抛未捕获异常退出，
  // 用户只看到「DSH 没起来」。这里明确写日志并退出。
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      const message = `端口 ${PORT} 已被占用：多半是已经开着另一个小鹈鹕（开发实例或另一个安装版本）。请关掉多余的实例后重开。`;
      log('error', 'core', message);
      // 同时打到控制台。log() 只写 activity.log，而 `npm start` 的窗口里看不到它，
      // 用户只会看到 launcher 的「核心退出，code=1」，完全不知道是端口冲突
      // —— 表现就是「内置 DSH 起不来」。
      console.error('[core] ' + message);
      console.error(`[core] 已占用的地址：http://127.0.0.1:${PORT}（先关掉它就占用的那个实例）`);
    } else {
      const message = '核心 HTTP 服务启动失败：' + String((e && e.message) || e);
      log('error', 'core', message);
      console.error('[core] ' + message);
    }
    setTimeout(() => process.exit(1), 300);
  });

  startHeartbeat((cfg.heartbeat && cfg.heartbeat.intervalSec) || 30);

  const scheduler = new Scheduler();
  const chatMemory = require('./memory/chat-memory');
  chatMemory.initialize();
  scheduler.register({ name: 'chat-memory', intervalMs: 5000, immediate: true, run: () => chatMemory.processOnce({ config: loadConfig() }) });
  scheduler.register({
    name: 'remind',
    intervalMs: 60 * 1000,
    run: () => runReminders({ config: cfg }),
    immediate: true
  });
  scheduler.register({
    name: 'email-analysis',
    intervalMs: 5000,
    run: () => emailService.processJobs(2)
  });
  scheduler.register({
    name: 'relation',
    intervalMs: 24 * 60 * 60 * 1000,
    run: () => runRelationCheck({ config: cfg })
  });
  scheduler.register({
    name: 'chat-archive',
    intervalMs: 24 * 60 * 60 * 1000,
    run: () => chatDb.archiveExpired(),
    immediate: true
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

  // 意图识别不再「每复制一条就扫一遍」：统一交给 requestIntentExtraction 排队，
  // 连续复制会合并成一轮，两轮之间还有冷却（intent.minIntervalMinutes）。
  const triggerIntent = () => requestIntentExtraction({ config: cfg, reason: 'capture' });

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
  emailService.start().catch((error) => log('warn', 'email', '邮件服务启动失败：' + ((error && error.message) || error)));

  // 确保小鹈鹕专用 DSH WebUI 可用；不可用则自动拉起。
  try {
    const webStart = await mainSession.ensureReady();
    if (webStart && webStart.ok) {
      // 启动是后台进行的（这台机器上 DSH 实测要 40 秒左右才监听），不阻塞微信通道与剪贴板监听
      log('info', 'agent', webStart.started ? 'DSH WebUI 已在后台启动' : 'DSH WebUI 已就绪');
    } else if (webStart && webStart.pending) {
      log('warn', 'agent', `DSH WebUI 仍在启动中：${webStart.error || ''}（后续请求会自动等它就绪）`);
    } else {
      log('error', 'agent', 'DSH WebUI 启动失败：' + ((webStart && webStart.error) || '未知错误'));
    }
  } catch (e) {
    log('warn', 'agent', 'DSH WebUI 启动/探测失败：' + String((e && e.message) || e));
  }

  let wechat = null;
  const handleChannelMessage = async (m) => {
    const replyCfg = (cfg.agent && cfg.agent.reply) || {};
    if (!m.content) return;

    // 微信通道消息定位为「主对话」：长期保存在 conversations，
    // 并拥有稳定 DSH Web 会话 agent:main:weixin:<user>；不写入联系人记忆归档。
    const session = 'agent:main:weixin:' + (m.from || 'default');
    conversations.append(session, {
      role: 'user',
      text: m.content,
      attachments: (m.attachments || []).map(publicAttachment)
    });
    if (replyCfg.enabled === false || !wechat) return;

    try {
      const steered = await mainSession.steer({
        sessionKey: session,
        message: m.content,
        attachments: m.attachments || []
      });
      if (steered && steered.ok) {
        log('info', 'weixin', '微信后续消息已插入当前 Agent 生成');
        return;
      }
    } catch (error) {
      log('warn', 'agent', '微信消息插话失败，将作为下一轮处理：' + String((error && error.message) || error));
    }
    const full = conversations.get(session);
    const history = full.slice(-20, -1).map((e) => ({
      role: e.role === 'bot' ? 'bot' : 'user',
      text: e.text
    }));

    let r = null;
    try {
      // 微信消息直接交给长期 DSH 会话，由 DSH 自己决定是否调用工具。
      // 微信协议不支持流式回复，因此等待整轮执行完成后一次性发送最终文本。
      r = await mainSession.send({
        sessionKey: session,
        message: m.content,
        attachments: m.attachments || [],
        history,
        timeoutMs: 180000
      });
    } catch (e) {
      log('error', 'agent', '微信主会话发送异常：' + String((e && e.message) || e));
    }

    // DSH Web 不可用时降级：headless 或直连模型，保证微信仍能收到回复。
    if (!r || !r.ok) {
      try {
        r = await answerWechatMessage({
          message: [WEIXIN_MEDIA_INSTRUCTIONS, formatAttachmentContext(m.attachments), m.content].filter(Boolean).join('\n\n'),
          history,
          userId: m.from || 'default',
          config: cfg
        });
      } catch (e) {
        log('error', 'agent', '微信回复降级异常：' + String((e && e.message) || e));
      }
    }

    if (r && r.ok && r.text) {
      const prepared = await prepareReply(r.text);
      const text = prepared.text;
      const delivery = await deliverReply(wechat, { to: m.from, text, attachments: prepared.attachments, contextToken: m.contextToken || '' });
      if (delivery && (delivery.text || (delivery.attachments || []).length)) {
        conversations.append(session, {
          role: 'bot',
          text: delivery.text || '',
          attachments: delivery.attachments || [],
          agentEvents: historyEventList((r && r.events) || [])
        });
      }
      if (delivery && delivery.ok) {
        log('info', 'weixin', `微信 Agent 回复成功（${r.mode || 'unknown'}）`);
      } else {
        log('error', 'weixin', `微信 Agent 最终发送失败：${(delivery && delivery.error) || '未知错误'}`);
      }
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
    onBatch: ({ msgs, allMsgs, contact, target, targetWindow, repeat = false, media = null }) => {
      // target 是采集侧算出的归属（群聊/私聊/判不出来 + 成员名），比裸字符串可靠：
      // 群里只有一个人说话时，只有它（或截屏读到的会话名）能看出这是群。
      // 老调用方只给 contact 字符串时，describeTarget 会当成私聊，行为与升级前一致。
      const batch = describeTarget(target || contact);
      const batchName = batch.name;
      const isGroup = batch.isGroup;
      // repeat = 同一段聊天又被复制了一次（内容早已归档）。此时不重复归档、不发“已录入”通知，
      // 但仍要重新给建议：用户再复制一次，意思就是「再给我建议」。
      const hadContact = batchName ? !!chatDb.getMember(batchName) : true;
      // 带附件时要先落盘、生成描述（异步），所以整条链路走 Promise；
      // 附件描述只在首次导入生成，之后 agent 回读直接读库里的文字。
      const archiving = (!repeat && media)
        ? ingestCapturedBatch(msgs, target || contact, { media, allMsgs, config: cfg }).then((result) => {
          if (result.visionUnsupported) {
            log('warn', 'capture', '当前模型不支持视觉，图片只按元数据记录');
            notifyUser({
              event: 'visionUnavailable',
              config: cfg,
              title: '图片暂时只能按元数据记录',
              message: '这次聊天里的图片没有生成内容描述：当前模型不支持视觉。可在设置 → 模型服务里换成支持视觉的模型，或单独配置一个视觉模型；配好后再复制一次同一段聊天即可补上描述。'
            }).catch((e) => log('warn', 'capture', '视觉能力提示发送失败：' + String((e && e.message) || e)));
          }
          return result;
        })
        : Promise.resolve({ added: repeat ? 0 : ingestMessages(msgs, target || contact) });

      archiving.then(({ added }) => {
        if (!added) return;
        triggerIntent();
        const newContactText = !hadContact && batchName && !isGroup
          ? `\n识别到新联系人「${batchName}」，请在联系人页面补充备注和描述。`
          : '';
        notifyUser({ event: 'captureComplete', config: cfg, title: '聊天记录已录入', message: `已录入 ${added} 条聊天记录${batchName ? `，${batch.label}：${batchName}` : ''}。${newContactText}` })
          .catch((e) => log('warn', 'capture', '录入完成通知失败：' + String((e && e.message) || e)));
      }).catch((e) => {
        log('error', 'capture', '归档失败：' + String((e && e.message) || e));
        // 抛出给采集层：让它把这批从「已导入」里撤掉，用户重新复制还能重试，
        // 否则带附件的批次失败一次就永久丢失（和同步路径同样的坑）。
        throw e;
      })
        .finally(() => {
          // 回复建议只对私聊生成：群聊没有「对谁说」的上下文，硬套联系人逻辑会把群名当人名、
          // 拿群成员之外的资料拼建议。群聊建议需要单独策略（选谁回、群语境），留作后续。
          if (isGroup) {
            log('info', 'reply', '群聊批次暂不生成回复建议（群上下文策略待定）');
            return;
          }
          // 回复建议：先归档再生成，失败不影响归档
          generateReplySuggestions({ contact: batchName, targetWindow, config: cfg })
            .catch((e) => log('warn', 'reply', '回复建议生成失败：' + String((e && e.message) || e)));
        });
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
    emailService.stop().catch(() => {});
    scheduler.stop();
    mainSession.stop();
    stopHeartbeat();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('message', (message) => {
    if (message && message.type === 'shutdown') shutdown();
  });
  if (process.send) {
    process.on('disconnect', shutdown);
    if (!process.connected) shutdown();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[core] 启动失败', e);
    process.exit(1);
  });
}
