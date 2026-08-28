// 回复建议回填：根据服务端保存的 suggestionId + index 安全执行“剪贴板 + 激活窗口 + Ctrl+V”。
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { getCurrent, lock, unlock, consume } = require('./suggestion-store');
const { markInternalWrite } = require('../capture/internal-clipboard');

const SCRIPT = path.join(__dirname, '..', 'capture', 'paste-to-window.ps1');

function runPasteScript(handle, text) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
      '-Handle', String(handle || 0),
      '-TextB64', Buffer.from(String(text), 'utf8').toString('base64')
    ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
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

async function applySuggestion(id, index) {
  const s = getCurrent();
  if (!s || s.id !== id) return { ok: false, error: '建议不存在或已失效' };
  if (!Number.isInteger(index) || index < 0 || index >= (s.options || []).length) {
    return { ok: false, error: '建议序号无效' };
  }
  if (!lock(id)) return { ok: false, error: '该建议正在使用中' };

  const text = s.options[index].text;
  const handle = s.targetWindow && s.targetWindow.handle ? String(s.targetWindow.handle) : null;
  markInternalWrite();

  // 无窗口句柄：至少把文本复制到剪贴板，让用户手动粘贴
  if (!handle) {
    try {
      await new Promise((resolve, reject) => {
        const ps = spawn('powershell.exe', [
          '-NoProfile', '-Command',
          `Set-Clipboard -Value ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(text, 'utf8').toString('base64')}')))`
        ], { stdio: 'ignore', windowsHide: true });
        ps.on('error', reject);
        ps.on('close', resolve);
      });
      unlock(id);
      return { ok: false, degraded: true, mode: 'clipboard', error: '未记录到微信窗口，已复制文本，请手动粘贴' };
    } catch (e) {
      unlock(id);
      return { ok: false, error: '复制到剪贴板失败：' + String(e.message || e) };
    }
  }

  try {
    const r = await runPasteScript(handle, text);
    if (r.ok) {
      consume(id);
      return { ok: true, mode: 'pasted' };
    }
    unlock(id);
    return { ok: false, degraded: true, mode: 'clipboard', error: r.error || '回填失败，文本已复制，请手动粘贴' };
  } catch (e) {
    unlock(id);
    return { ok: false, degraded: true, mode: 'clipboard', error: String(e.message || e) };
  }
}

module.exports = { applySuggestion };
