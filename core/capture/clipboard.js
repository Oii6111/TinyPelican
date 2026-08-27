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

function msgKey(m) {
  return `${m.name}|${m.ts}|${m.type}|${m.content}`;
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
      try {
        const text = Buffer.from(line.slice(7), 'base64').toString('utf8');
        this._handleClip(text);
      } catch {}
    }
  }

  _handleClip(text) {
    const msgs = parseChatText(text);
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
      this.onBatch({ msgs: fresh, contact });
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

module.exports = { ClipboardWatcher };
