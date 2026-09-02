// 小鹈鹕核心 — Node 版剪贴板监听
// 常驻一个轻量 PowerShell 传感器读取剪贴板变化，Node 侧解析、去重、回调。
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { parseChatText, getBatchContact } = require('../lib/chat-parser');
const { loadConfig } = require('../lib/config');
const { log } = require('../lib/log');
const { applyVoiceFill } = require('../ingest/pipeline');
const voice = require('../memory/stores/voice');
const internalClipboard = require('./internal-clipboard');

function msgKey(m) {
  return `${m.name}|${m.ts}|${m.type}|${m.content}`;
}

// 解析传感器输出：
//   新格式 CHANGE <handle> <pid> <processName> <left> <top> <right> <bottom> <dpi> <b64>
//   兼容格式 CHANGE <handle> <pid> <processName> <b64>
//   兼容格式 CHANGE <handle> <b64>
//   旧格式 CHANGE <b64>
function parseSensorLine(line) {
  const full = line.match(/^CHANGE\s+(-?\d+)\s+(\d+)\s+([^\s]+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(.+)$/);
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
  const current = line.match(/^CHANGE\s+(-?\d+)\s+(\d+)\s+([^\s]+)\s+(.+)$/);
  if (current) {
    return {
      handle: current[1] === '0' ? null : current[1],
      pid: current[2] === '0' ? null : current[2],
      processName: current[3] === '-' ? null : current[3],
      encoded: current[4]
    };
  }
  const two = line.match(/^CHANGE\s+(-?\d+)\s+(.+)$/);
  if (two) return { handle: two[1] === '0' ? null : two[1], encoded: two[2] };
  const legacy = line.match(/^CHANGE\s+(.+)$/);
  if (legacy) return { handle: null, encoded: legacy[1] };
  return null;
}

class ClipboardWatcher {
  constructor({ onBatch = () => {}, config = null } = {}) {
    this.onBatch = onBatch;
    this.config = config || loadConfig();
    this.pollMs = this.config.pollMs || 700;
    this.minMatchLines = this.config.minMatchLines || 2;
    this.selfNicknames = Array.isArray(this.config.selfNicknames) ? this.config.selfNicknames : [];
    this.running = false;
    this.child = null;
    this.seen = new Set();
    this._buffer = '';
    this._debounceTimer = null;
    this._restartTimer = null;
  }

  start() {
    if (this.running) return;
    const captureCfg = this.config.capture || {};
    if (captureCfg.enabled === false) {
      log('info', 'capture', '剪贴板捕获未启用，跳过');
      return;
    }
    this.running = true;
    const sensor = path.join(__dirname, 'clipboard-sensor.ps1');
    this.child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', sensor, '-PollMs', String(this.pollMs)
    ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onSensorData(chunk));
    this.child.on('exit', () => {
      this.child = null;
      if (this.running) {
        log('warn', 'capture', '剪贴板传感器退出，5 秒后重启');
        this._restartTimer = setTimeout(() => this.start(), 5000);
      }
    });
    this.child.on('error', (e) => {
      log('error', 'capture', '剪贴板传感器启动失败：' + (e && e.message ? e.message : e));
      this.running = false;
    });
    log('info', 'capture', '剪贴板监听已启动');
  }

  _onSensorData(chunk) {
    this._buffer += chunk;
    let idx;
    while ((idx = this._buffer.indexOf('\n')) >= 0) {
      const line = this._buffer.slice(0, idx).trim();
      this._buffer = this._buffer.slice(idx + 1);
      if (!line.startsWith('CHANGE ')) continue;
      const parsed = parseSensorLine(line);
      if (!parsed) continue;
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
        });
      } catch {}
    }
  }

  _handleClip(text, targetWindow = null) {
    const msgs = parseChatText(text);
    const isWeChat = !!(
      targetWindow &&
      typeof targetWindow.processName === 'string' &&
      /^(wechat|weixin)(\.exe)?$/i.test(targetWindow.processName.trim())
    );
    const b = targetWindow && targetWindow.bounds;
    const boundsValid = !!(
      isWeChat && b &&
      Number.isFinite(Number(b.left)) && Number.isFinite(Number(b.top)) &&
      Number.isFinite(Number(b.right)) && Number.isFinite(Number(b.bottom)) &&
      Number(b.right) > Number(b.left) && Number(b.bottom) > Number(b.top)
    );
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
    // 不是聊天记录：若存在待回填语音，则把这段文本当作语音转写内容回填
    if (msgs.length === 0 && voice.list().length) {
      const p = voice.fillFirst(text);
      if (p) {
        applyVoiceFill(p);
        log('info', 'capture', '语音回填：' + (p.contact || p.name) + ' ' + p.ts);
      }
      return;
    }
    if (msgs.length < this.minMatchLines) return;
    const fresh = msgs.filter((m) => !this.seen.has(msgKey(m)));
    if (!fresh.length) return;
    for (const m of fresh) this.seen.add(msgKey(m));
    if (this.seen.size > 100000) {
      this.seen = new Set([...this.seen].slice(-100000));
    }
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      const contact = getBatchContact(msgs, this.selfNicknames);
      log('info', 'capture', `捕获 ${fresh.length} 条新消息`);
      this.onBatch({ msgs: fresh, contact, targetWindow: windowRef });
    }, 500);
  }

  stop() {
    this.running = false;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    if (this._restartTimer) clearTimeout(this._restartTimer);
    if (this.child) {
      try { this.child.kill(); } catch {}
      this.child = null;
    }
  }
}

module.exports = { ClipboardWatcher, parseSensorLine };
