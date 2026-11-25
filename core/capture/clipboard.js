// 小鹈鹕核心 — Node 版剪贴板监听
// 常驻一个轻量 PowerShell 传感器读取剪贴板变化，Node 侧解析、去重、回调。
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getPaths } = require('../lib/paths');
const chatParser = require('../lib/chat-parser');
const { parseChatDetail, looksLikeChatText } = chatParser;
const { loadConfig } = require('../lib/config');
const { log } = require('../lib/log');
const { applyVoiceFill } = require('../ingest/pipeline');
const voice = require('../memory/stores/voice');
const internalClipboard = require('./internal-clipboard');

function msgKey(m) {
  return `${m.name}|${m.ts}|${m.type}|${m.content}`;
}

// 微信主窗口、独立聊天窗口（4.x 用 WeChatAppEx 承载）都要认成微信，
// 否则拿不到窗口矩形，建议卡片只能退到屏幕角落。
const WEIXIN_PROCESS_RE = /^(?:wechat|weixin)(?:appex|app)?(?:\.exe)?$/i;

function isWeixinProcess(name) {
  const value = String(name || '').trim();
  return !!value && WEIXIN_PROCESS_RE.test(value);
}

// 窗口矩形是否可用于定位：最小化的窗口会被 Windows 停在 -32000 附近，
// 这种坐标算出来的锚点会把卡片甩到屏幕外，必须当无效处理。
function usableWindowBounds(bounds) {
  if (!bounds) return false;
  const left = Number(bounds.left);
  const top = Number(bounds.top);
  const right = Number(bounds.right);
  const bottom = Number(bounds.bottom);
  if (![left, top, right, bottom].every((value) => Number.isFinite(value))) return false;
  if (left < -10000 || top < -10000) return false;
  if (right <= left || bottom <= top) return false;
  if (right - left > 20000 || bottom - top > 20000) return false;
  return true;
}

// ── 批次归属判定 ───────────────────────────────────────────────────────
// 统一走 chat-parser 的 resolveBatchTarget：它区分私聊/群聊/判不出来三态，
// 并用「多个发言人」或「截屏读到的窗口会话名」互相修正。
// 这里不再保留本地兜底实现——T3 已落地，两套语义并存只会在以后改漏一边。
const resolveBatchTarget = chatParser.resolveBatchTarget;

// 解析传感器输出：
//   新格式 CHANGE <handle> <pid> <processName> <left> <top> <right> <bottom> <dpi> <b64>
//   兼容格式 CHANGE <handle> <pid> <processName> <b64>
//   兼容格式 CHANGE <handle> <b64>
//   旧格式 CHANGE <b64>
//
// base64 通道收紧成合法字符集：旧实现用 (.+)$ 兜底，传感器元数据错位时
// （例如原生 GetWindowRect 不可用、字段变空）会把 "0 - 0 0 0 0 0 xxxx" 整段
// 当成 base64 解出一串乱码，看起来像一次成功的剪贴板变化。宁可不认，也不能认错。
const B64_RE = '([A-Za-z0-9+/]+={0,2})';
const CHANGE_FULL_RE = new RegExp(`^CHANGE\\s+(-?\\d+)\\s+(\\d+)\\s+([^\\s]+)\\s+(-?\\d+)\\s+(-?\\d+)\\s+(-?\\d+)\\s+(-?\\d+)\\s+(\\d+)\\s+${B64_RE}$`);
const CHANGE_META_RE = new RegExp(`^CHANGE\\s+(-?\\d+)\\s+(\\d+)\\s+([^\\s]+)\\s+${B64_RE}$`);
const CHANGE_HANDLE_RE = new RegExp(`^CHANGE\\s+(-?\\d+)\\s+${B64_RE}$`);
const CHANGE_LEGACY_RE = new RegExp(`^CHANGE\\s+${B64_RE}$`);

function parseSensorLine(line) {
  const full = line.match(CHANGE_FULL_RE);
  if (full) {
    return {
      handle: full[1] === '0' ? null : full[1],
      pid: full[2] === '0' ? null : full[2],
      processName: full[3] === '-' ? null : full[3],
      bounds: {
        left: Number(full[4]),
        top: Number(full[5]),
        right: Number(full[6]),
        bottom: Number(full[7])
      },
      dpi: Number(full[8]) || 0,
      encoded: full[9]
    };
  }
  const current = line.match(CHANGE_META_RE);
  if (current) {
    return {
      handle: current[1] === '0' ? null : current[1],
      pid: current[2] === '0' ? null : current[2],
      processName: current[3] === '-' ? null : current[3],
      encoded: current[4]
    };
  }
  const two = line.match(CHANGE_HANDLE_RE);
  if (two) return { handle: two[1] === '0' ? null : two[1], encoded: two[2] };
  const legacy = line.match(CHANGE_LEGACY_RE);
  if (legacy) return { handle: null, encoded: legacy[1] };
  return null;
}

// 附件的传感器行：MEDIA <b64(UTF-8 JSON)>，内容 { files, wechat, hasImage }。
// 解析失败当作「这次没有附件」，绝不因为附件把文本捕获一起拖垮。
function parseSensorMedia(encoded) {
  try {
    const media = JSON.parse(Buffer.from(String(encoded || ''), 'base64').toString('utf8'));
    if (!media || typeof media !== 'object') return null;
    const files = (Array.isArray(media.files) ? media.files : [])
      .map((file) => (typeof file === 'string' ? { path: file } : file))
      .filter((file) => file && String(file.path || '').trim())
      .map((file) => ({ path: String(file.path), name: String(file.name || path.basename(String(file.path))) }));
    const wechat = (Array.isArray(media.wechat) ? media.wechat : [])
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({ ...(item.file ? { file: String(item.file) } : {}), ...(item.text ? { text: String(item.text) } : {}) }));
    if (!files.length && !wechat.length) return null;
    return { files, wechat };
  } catch { return null; }
}

class ClipboardWatcher {
  constructor({ onBatch = () => {}, config = null, sessionReader = null, stripCapture = null } = {}) {
    this.onBatch = onBatch;
    this.config = config || loadConfig();
    // 读「当前窗口是哪个会话」的实现（截标题条 + 视觉模型）。测试可注入假实现。
    // 传 null / 不传就用内置的；显式传 false 关掉（只靠发言人名字推断）。
    this.sessionReader = sessionReader;
    // 截图实现（测试可注入假实现，避免真的去截屏）
    this.stripCapture = stripCapture;
    this.pollMs = this.config.pollMs || 700;
    // 最少匹配行数：按「参与匹配的原始行数」判定（一条块格式消息 = 3 行起），
    // 不是按消息条数，这样复制单条聊天消息也能被识别。
    this.minMatchLines = Math.max(1, Math.round(Number(this.config.minMatchLines) || 2));
    this.selfNicknames = Array.isArray(this.config.selfNicknames) ? this.config.selfNicknames : [];
    this.running = false;
    this.child = null;
    this.seen = new Set();
    this._buffer = '';
    // 传感器先发 MEDIA 再发 CHANGE：先收着，交给紧随其后的那条剪贴板内容
    this._pendingMedia = null;
    // 等待交付的批次队列：静默窗口内的多次复制都排在这里，窗口结束后按顺序全部交付。
    // 不能用「覆盖定时器」的写法——那样前一批的新消息会被丢掉，而它们已经进了 seen，等于永久丢失。
    this._pendingBatches = [];
    this._debounceTimer = null;
    // 交付串行化：上一轮还在等异步结果（如会话名识别）时，新一轮不能插进来，
    // 否则两轮各拿一半队列，交付顺序会乱。
    this._flushing = false;
    this._restartTimer = null;
    // 心跳看门狗：传感器启动成功但卡死（PowerShell 侧 Get-Clipboard 卡住 /
    // 原生调用被安全软件拦下）时，仅靠 exit 事件是等不到的，必须看输出流。
    this._healthTimer = null;
  }

  start() {
    if (this.running) return;
    const captureCfg = this.config.capture || {};
    if (captureCfg.enabled === false) {
      log('info', 'capture', '剪贴板捕获未启用，跳过');
      return;
    }
    this.running = true;
    this._buffer = '';
    this._pendingMedia = null;
    const sensor = path.join(__dirname, 'clipboard-sensor.ps1');
    // 临时目录隔离：传感器进程跑的是 PowerShell，安全软件常把它往 TEMP 写东西的行为
    // 当成可疑；把 TEMP/TMP 指到我们自己的数据目录下，权限和清理都可控。
    const sensorEnv = { ...process.env };
    try {
      const temporary = path.join(getPaths().dataDir, 'tmp', 'clipboard-sensor');
      fs.mkdirSync(temporary, { recursive: true });
      sensorEnv.TEMP = temporary;
      sensorEnv.TMP = temporary;
    } catch (error) {
      log('warn', 'capture', '无法创建剪贴板组件临时目录：' + error.message);
    }
    let child;
    try {
      child = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', sensor, '-PollMs', String(this.pollMs)
      ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: sensorEnv });
    } catch (error) {
      // 同步 spawn 失败（常见：安全软件 / 组策略拦了 powershell.exe）不能把核心整个带崩：
      // 剪贴板只是「录聊天」这一条链路，核心退出会让用户连设置页都进不去。
      this.running = false;
      log('error', 'capture', '剪贴板传感器启动失败：' + ((error && error.message) || error) + '，15 秒后重试');
      this._scheduleRestart(15000);
      return;
    }
    this.child = child;
    child.stdout.setEncoding('utf8');
    let lastActivity = Date.now();
    let connected = false;
    child.stdout.on('data', (chunk) => {
      lastActivity = Date.now();
      if (!connected) {
        connected = true;
        log('info', 'capture', `剪贴板传感器已连接，通道编码=${chunk.includes('\0') ? 'UTF-16' : 'UTF-8'}`);
      }
      this._onSensorData(chunk);
    });
    this._healthTimer = setInterval(() => {
      if (Date.now() - lastActivity > Math.max(15000, this.pollMs * 5)) {
        log('warn', 'capture', '剪贴板传感器无响应，正在重新启动');
        child.kill();
      }
    }, 3000);
    this._healthTimer.unref();
    child.on('exit', () => {
      if (this.child !== child) return;
      clearInterval(this._healthTimer);
      this._healthTimer = null;
      this.child = null;
      if (this.running) {
        log('warn', 'capture', '剪贴板传感器退出，5 秒后重启');
        this.running = false;
        this._scheduleRestart(5000);
      }
    });
    child.on('error', (e) => {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
      log('error', 'capture', '剪贴板传感器启动失败：' + (e && e.message ? e.message : e));
      if (this.child === child) this.child = null;
      if (this.running) {
        this.running = false;
        this._scheduleRestart(15000);
      }
    });
    log('info', 'capture', '剪贴板监听已启动');
  }

  // 传感器起不来时按固定间隔重试；安全软件首次拦截往往只拦第一次，
  // 重试能让它在用户放行后自动恢复，而不是整个进程就没了。
  _scheduleRestart(delayMs) {
    if (this._restartTimer) return;
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (this.running) return;
      this.start();
    }, delayMs);
  }

  _onSensorData(chunk) {
    this._buffer += chunk;
    let idx;
    while ((idx = this._buffer.indexOf('\n')) >= 0) {
      const line = this._buffer.slice(0, idx).trim();
      this._buffer = this._buffer.slice(idx + 1);

      // 传感器自身的健康信号：不再是「只有剪贴板变化才有输出」，
      // 这样 Node 侧的心跳看门狗才能区分「没复制东西」和「进程卡死」。
      if (line.startsWith('SENSOR_ERROR ')) {
        log('warn', 'capture', '剪贴板组件异常：' + Buffer.from(line.slice(13), 'base64').toString('utf8'));
        continue;
      }
      if (line.startsWith('SENSOR_READY ')) {
        log('info', 'capture', '剪贴板读取就绪，字符数=' + Number(line.slice(13)));
        continue;
      }

      if (line.startsWith('MEDIA ')) {
        const media = parseSensorMedia(line.slice(6).trim());
        if (media) this._pendingMedia = media;
        continue;
      }
      if (!line.startsWith('CHANGE ')) continue;
      const parsed = parseSensorLine(line);
      if (!parsed) continue;
      // 附件与文本是同一时刻的一次复制：取走待处理项，避免下一批误用
      const media = this._pendingMedia;
      this._pendingMedia = null;
      try {
        const text = Buffer.from(parsed.encoded, 'base64').toString('utf8');
        // 内部回填写剪贴板：只忽略内容完全相同的那一次变化
        if (internalClipboard.isInternalClipboardWrite(text)) continue;
        this._handleClip(text, {
          handle: parsed.handle || null,
          pid: parsed.pid || null,
          processName: parsed.processName || null,
          bounds: parsed.bounds || null,
          dpi: parsed.dpi || 0
        }, media);
      } catch (error) {
        // 单行失败不能带走整个传感器连接：后面还可能有别的复制
        log('error', 'capture', '剪贴板消息处理失败：' + ((error && error.message) || error));
      }
    }
  }

  _handleClip(text, targetWindow = null, media = null) {
    const detail = parseChatDetail(text);
    const msgs = detail.messages;
    const isWeChat = isWeixinProcess(targetWindow && targetWindow.processName);
    const b = targetWindow && targetWindow.bounds;
    const boundsValid = !!(isWeChat && usableWindowBounds(b));
    const windowRef = targetWindow && targetWindow.handle ? {
      handle: String(targetWindow.handle),
      pid: targetWindow.pid ? String(targetWindow.pid) : null,
      processName: targetWindow.processName || null,
      bounds: boundsValid ? {
        left: Number(b.left),
        top: Number(b.top),
        right: Number(b.right),
        bottom: Number(b.bottom)
      } : null,
      dpi: boundsValid ? (Number(targetWindow.dpi) || 0) : 0
    } : null;
    // 有句柄却定位不了时打一条日志：下次「弹窗跑到角落」能直接看出是哪个进程/什么矩形
    if (windowRef && !windowRef.bounds && msgs.length) {
      log('info', 'capture', `窗口未识别，建议卡片不使用微信定位：process=${windowRef.processName || '未知'} rect=${b ? `${b.left},${b.top},${b.right},${b.bottom}` : '无'}`);
    }
    // 不是聊天记录：若存在待回填语音，则把这段文本当作语音转写内容回填。
    // 但「看着像聊天记录却没解析出消息」的文本不能当作语音转写，否则复制的聊天内容
    // 会被写进旧的语音消息里（既丢了聊天，又污染了归档）。
    if (msgs.length === 0 && voice.list().length) {
      if (looksLikeChatText(text)) {
        log('warn', 'capture', '疑似聊天记录但没解析出消息，已跳过（不当语音转写回填）');
        return;
      }
      const p = voice.fillFirst(text);
      if (p) {
        applyVoiceFill(p);
        log('info', 'capture', '语音回填：' + (p.contact || p.name) + ' ' + p.ts);
      }
      return;
    }
    if (detail.matchedLines < this.minMatchLines) {
      // 微信里复制了但没到识别门槛：给一条可诊断的日志，否则用户只看到「没反应」
      if (isWeChat) log('warn', 'capture', '微信复制内容未达到聊天记录识别条件，请多选聊天消息后使用复制');
      return;
    }
    const fresh = msgs.filter((m) => !this.seen.has(msgKey(m)));
    if (fresh.length) {
      for (const m of fresh) this.seen.add(msgKey(m));
      if (this.seen.size > 100000) {
        this.seen = new Set([...this.seen].slice(-100000));
      }
    }
    // 同一段聊天又被复制了一次：不重复归档（见上面的 seen 去重），但要告诉上层「用户又要了一次」，
    // 否则回复建议卡片不会再弹出来。
    // 复制这一刻微信还在前台，先把标题条截下来；识别推迟到交付前
    this._emitBatch(msgs, fresh, windowRef, !fresh.length, media, this._startStrip(windowRef));
  }

  // 静默窗口 250ms：把窗口内的复制都排进队列，结束时按复制顺序逐批交付。
  // 连续复制（比如快速连按 Ctrl+C 复制两段不同聊天）时不能吞掉任何一批：
  // 只要内容符合聊天记录格式，每一批都必须入库。
  _emitBatch(msgs, fresh, windowRef, repeat, media = null, stripPromise = null) {
    const queued = this._pendingBatches;
    const previous = queued[queued.length - 1];
    const sameSelection = (a, b) => a.length === b.length && a.every((m, i) => msgKey(m) === msgKey(b[i]));
    if (previous && sameSelection(previous.msgs, msgs)) {
      // 同一段聊天在被交付前又被上报了一次（传感器抖动 / 用户连按两次）：
      // 只算一次——保留先到那批的入库内容，不会变成「归档一次 + 再要一次建议」。
      queued[queued.length - 1] = {
        msgs: previous.msgs,
        fresh: previous.fresh.length ? previous.fresh : fresh,
        windowRef: windowRef || previous.windowRef,
        repeat: previous.repeat && repeat,
        media: previous.media || media,
        stripPromise: previous.stripPromise || stripPromise
      };
    } else {
      queued.push({ msgs, fresh, windowRef, repeat, media, stripPromise });
    }
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this._flushBatches(), 250);
  }

  // 复制那一刻就把标题条截下来。微信这时还是前台，晚一点可能被别的窗口盖住——
  // Qt 窗口被遮挡时 PrintWindow 会返回一片纯色，那就白截了。
  // 走内置识别时先确认有可用的视觉模型：截一次要起 PowerShell + 写临时文件，
  // 没配模型时先截再发现读不了，等于每批白付一次截图成本。
  // 外部注入的 sessionReader（测试/自定义）自己负责，不受这里限制。
  _visionReady() {
    if (typeof this.sessionReader === 'function') return true;
    try {
      return require('./session-title').canReadSessionTitle(this.config);
    } catch {
      return false;
    }
  }

  // 只负责截，不负责识别；识别在交付前那一刻做。
  _startStrip(windowRef) {
    if (this.sessionReader === false) return null;
    if (!windowRef || !windowRef.handle) return null;
    if (!isWeixinProcess(windowRef.processName)) return null;
    const captureCfg = this.config.capture || {};
    // 默认开启（显式 false 才关）：只有它能纠正「群里只有一个人说话被当成私聊」。
    // 关闭后完全退回按发言人名字的启发式，不截屏、不调模型。
    if (captureCfg.readSessionTitle === false) return null;
    if (!this._visionReady()) return null;
    try {
      const capture = this.stripCapture || require('./session-title').captureStrip;
      return Promise.resolve(capture(windowRef.handle)).catch(() => null);
    } catch {
      return null;
    }
  }

  // 把「截图 + 识别」两部分接起来。读当前窗口的会话名；任何一步失败都返回 null，
  // 调用方退回「数发言人」的启发式，绝不挡住入库。
  //
  // 读不到会重截一次：复制那一刻微信理应在前台，但可能刚好被通知/弹窗盖住，
  // 或者 Qt 窗口还没绘完就 PrintWindow。隔 250ms 再试一次基本都能拿到。
  async _readSession(windowRef, stripPromise = null) {
    if (this.sessionReader === false) return null;
    if (!windowRef || !windowRef.handle) return null;
    if (!isWeixinProcess(windowRef.processName)) return null;
    const captureCfg = this.config.capture || {};
    // 默认开启（显式 false 才关）：会截窗口标题条 + 调一次视觉模型，用来确认「这是哪个会话」。
    // 没配视觉模型时（_visionReady 为假）直接返回 null，不截屏也不发请求。
    if (captureCfg.readSessionTitle === false) return null;
    if (!this._visionReady()) return null;

    const attempt = async (preCaptured) => {
      let bytes = null;
      try {
        if (preCaptured) bytes = await preCaptured;
        else {
          const capture = this.stripCapture || require('./session-title').captureStrip;
          bytes = await capture(windowRef.handle);
        }
      } catch {
        bytes = null;
      }
      if (!bytes || !bytes.length) return null;
      try {
        const reader = this.sessionReader || require('./session-title').readTitleFromBytes;
        const session = await reader(bytes, this.config);
        return session && session.name ? session : null;
      } catch (error) {
        log('warn', 'capture', '读取窗口会话名失败，改用发言人推断：' + String((error && error.message) || error).slice(0, 200));
        return null;
      }
    };

    const first = await attempt(stripPromise);
    if (first) return first;
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!this.running) return null;
    return attempt(null);
  }

  _deliver(item, target = { kind: 'unknown', name: '' }) {
    const contact = target.kind === 'contact' ? target.name : '';
    log('info', 'capture', item.repeat
      ? `捕获 ${item.msgs.length} 条重复消息（同一段聊天再次复制）`
      : `捕获 ${item.fresh.length} 条新消息${target.kind === 'group' ? `（群聊：${target.displayName}）` : ''}`);
    try {
      this.onBatch({ msgs: item.fresh, allMsgs: item.msgs, contact, target, targetWindow: item.windowRef, repeat: item.repeat, media: item.media || null });
    } catch (error) {
      // 一批出错不影响后面的批次：只要没入库就是数据丢失，所以逐批兜住并记日志
      log('error', 'capture', '批次交付失败：' + ((error && error.message) || error));
    }
  }

  // 退出时用：不等视觉模型，直接按发言人推断交付，别把最后一次复制丢在缓冲里。
  _flushSync() {
    if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }
    const queued = this._pendingBatches;
    this._pendingBatches = [];
    for (const item of queued) {
      this._deliver(item, resolveBatchTarget(item.msgs, this.selfNicknames, {}));
    }
  }

  async _flushBatches() {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = null;
    // 上一轮还在等视觉模型：让它先把队列吃完，避免两轮交错交付打乱顺序。
    // 这里只 return，不清队列——正在跑的那轮 while 会看到新排进来的批次。
    if (this._flushing) return;
    this._flushing = true;
    try {
      while (this._pendingBatches.length) {
        const queued = this._pendingBatches;
        this._pendingBatches = [];
        for (const item of queued) {
          // 窗口能告诉我们是哪个会话；读不到就退回「数发言人」。
          const session = await this._readSession(item.windowRef, item.stripPromise);
          this._deliver(item, resolveBatchTarget(item.msgs, this.selfNicknames, { session }));
        }
      }
    } finally {
      this._flushing = false;
    }
  }

  stop() {
    this.running = false;
    clearInterval(this._healthTimer);
    this._healthTimer = null;
    // 停止前把排队中还没交付的批次先交出去，别让最后一次复制丢在缓冲里
    if (this._pendingBatches.length) this._flushSync();
    else if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    if (this.child) {
      try { this.child.kill(); } catch {}
      this.child = null;
    }
  }
}

module.exports = { ClipboardWatcher, parseSensorLine, parseSensorMedia, isWeixinProcess, usableWindowBounds };
