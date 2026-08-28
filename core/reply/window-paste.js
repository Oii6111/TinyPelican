// 回复建议回填：根据服务端保存的 suggestionId + index 安全执行“剪贴板 + 激活窗口 + Ctrl+V”。
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { getCurrent, lock, unlock, consume } = require('./suggestion-store');
const { markInternalWrite } = require('../capture/internal-clipboard');

const SCRIPT = path.join(__dirname, '..', 'capture', 'paste-to-window.ps1');

function runPasteScript(target, text) {
  return new Promise((resolve) => {
    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
      '-Handle', String(target && target.handle ? target.handle : 0),
      '-TargetPid', String(target && target.pid ? target.pid : 0),
      '-TargetProcessName', String(target && target.processName ? target.processName : ''),
      '-TextB64', Buffer.from(String(text), 'utf8').toString('base64')
    ];
    const child = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', (e) => resolve({ ok: false, error: String(e.message || e) }));
    child.on('close', (code) => {
      const hasPasted = /PASTED/.test(out);
      if (code === 0 && hasPasted) return resolve({ ok: true });
      return resolve({ ok: false, error: out.trim() || `脚本退出码 ${code}` });
    });
  });
}

function copyTextToClipboard(text) {
  return new Promise((resolve) => {
    const b64 = Buffer.from(String(text), 'utf8').toString('base64');
    const child = spawn('powershell.exe', [
      '-NoProfile', '-Command',
      `$t=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); Set-Clipboard -Value $t`
    ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', (e) => resolve({ ok: false, error: String(e.message || e) }));
    child.on('close', (code) => {
      if (code === 0) return resolve({ ok: true });
      return resolve({ ok: false, error: out.trim() || `剪贴板写入失败，退出码 ${code}` });
    });
  });
}

async function applySuggestion(id, index) {
  const s = getCurrent();
  if (!s || s.id !== id) return { ok: false, error: '建议不存在或已失效' };
  if (!Number.isInteger(index) || index < 0 || index >= (s.options || []).length) {
    return { ok: false, error: '建议序号无效' };
  }
  if (!lock(id)) return { ok: false, error: '该建议正在使用中' };

  const text = s.options[index].text;
  const target = s.targetWindow || null;
  markInternalWrite(text);

  // 无窗口句柄：只复制到剪贴板，让用户手动粘贴
  if (!target || !target.handle) {
    const copied = await copyTextToClipboard(text);
    if (!copied.ok) {
      unlock(id);
      return { ok: false, error: '复制到剪贴板失败：' + copied.error };
    }
    unlock(id);
    return { ok: false, degraded: true, mode: 'clipboard', error: '未记录到微信窗口，已复制文本，请手动粘贴' };
  }

  const r = await runPasteScript(target, text);
  if (r.ok) {
    consume(id);
    return { ok: true, mode: 'pasted' };
  }
  // 脚本失败时文本已在剪贴板中，降级为手动粘贴；不消费建议，允许用户重试。
  unlock(id);
  return { ok: false, degraded: true, mode: 'clipboard', error: r.error || '回填失败，文本已复制，请手动粘贴' };
}

module.exports = { applySuggestion };
