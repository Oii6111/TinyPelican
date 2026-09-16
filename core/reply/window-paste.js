// 回复建议回填：根据服务端保存的 suggestionId + 方案序号安全执行“剪贴板 + 激活窗口 + Ctrl+V”。
// 一组建议可能包含多条连贯消息：先填第一条，用户发出去后再点“下一条”，逐条按顺序回填。
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { getCurrent, lock, unlock, setActivePlan } = require('./suggestion-store');
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
    // stderr 也要收：脚本解析失败/抛异常时 stdout 是空的，只有 stderr 能说明原因。
    const child = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => resolve({ ok: false, error: String(e.message || e) }));
    child.on('close', (code) => {
      if (code === 0 && /PASTED/.test(out)) return resolve({ ok: true });
      return resolve({ ok: false, error: describeFailure(out, err, code) });
    });
  });
}

// 脚本失败标记 -> 给用户看的话术。除 CLIPBOARD_FAILED / INTEROP_FAILED 外，
// 文本都已写入剪贴板（脚本第一步就是写剪贴板），所以提示可以带“已复制”。
const MARKER_HINTS = {
  CLIPBOARD_FAILED: '剪贴板被其它程序占用，写入失败，请稍后重试',
  INTEROP_FAILED: '无法加载系统接口，回填失败',
  NO_WINDOW: '没有找到微信窗口，文本已复制，请手动粘贴',
  WINDOW_CHANGED: '微信窗口已变化，为安全起见没有自动粘贴，文本已复制',
  FOREGROUND_BLOCKED: '微信没能切到前台，没有自动粘贴，文本已复制',
  SENDKEYS_FAILED: '按键发送失败，文本已复制，请手动粘贴'
};

// 把脚本输出整理成一句能看懂的错误：优先用脚本标记，其次用 PowerShell 的报错首行。
function describeFailure(stdout, stderr, code) {
  const marker = String(stdout || '').trim();
  const known = Object.keys(MARKER_HINTS).find((m) => marker.startsWith(m));
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\+/.test(l) && !/^At line|^At .*\.ps1:\d+ char/.test(l));
  const detail = lines.slice(0, 2).join(' ').slice(0, 240);
  if (known) return MARKER_HINTS[known];
  if (marker && detail) return `${marker}：${detail}`;
  if (marker) return marker;
  if (detail) return `脚本执行失败（退出码 ${code}）：${detail}`;
  return `脚本退出码 ${code}`;
}

function copyTextToClipboard(text) {
  return new Promise((resolve) => {
    const b64 = Buffer.from(String(text), 'utf8').toString('base64');
    const child = spawn('powershell.exe', [
      '-NoProfile', '-Command',
      `$t=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); Set-Clipboard -Value $t`
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => resolve({ ok: false, error: String(e.message || e) }));
    child.on('close', (code) => {
      if (code === 0) return resolve({ ok: true });
      return resolve({ ok: false, error: describeFailure(out, err, code) });
    });
  });
}

// 把一段文本安全填进目标窗口；失败时文本已在剪贴板中，降级为手动粘贴。
async function deliver(s, text) {
  if (!lock(s.id)) return { ok: false, error: '该建议正在使用中' };
  const target = s.targetWindow || null;
  markInternalWrite(text);

  // 无窗口句柄：只复制到剪贴板，让用户手动粘贴
  if (!target || !target.handle) {
    const copied = await copyTextToClipboard(text);
    unlock(s.id);
    if (!copied.ok) return { ok: false, error: '复制到剪贴板失败：' + copied.error };
    return { ok: false, degraded: true, mode: 'clipboard', error: '未记录到微信窗口，已复制文本，请手动粘贴' };
  }

  const r = await runPasteScript(target, text);
  unlock(s.id);
  if (r.ok) return { ok: true, mode: 'pasted' };
  return { ok: false, degraded: true, mode: 'clipboard', error: r.error || '回填失败，文本已复制，请手动粘贴' };
}

function sequenceState(activePlan) {
  if (!activePlan) return { sent: [], remaining: [], done: true };
  return {
    sent: (activePlan.sent || []).slice(),
    remaining: (activePlan.remaining || []).slice(),
    done: !(activePlan.remaining || []).length
  };
}

// 点选某一组方案：填入该组第一条消息，并把剩余几条挂成“顺序发送”状态。
async function applyPlan(id, planIndex) {
  const s = getCurrent();
  if (!s || s.id !== id) return { ok: false, error: '建议不存在或已失效' };
  const plans = s.plans || [];
  if (!Number.isInteger(planIndex) || planIndex < 0 || planIndex >= plans.length) {
    return { ok: false, error: '建议序号无效' };
  }
  const plan = plans[planIndex];
  const messages = (plan && plan.messages) || [];
  if (!messages.length) return { ok: false, error: '该建议没有可发送的内容' };

  const first = messages[0];
  const r = await deliver(s, first);
  if (!r.ok) {
    // 降级（只复制到剪贴板）时不算已发，用户可重试；顺序状态保持不变。
    return { ...r, plan: s.activePlan || null, ...sequenceState(s.activePlan) };
  }

  const activePlan = {
    planIndex,
    tone: plan.tone || '',
    sent: [first],
    remaining: messages.slice(1)
  };
  setActivePlan(id, activePlan.remaining.length ? activePlan : null);
  return {
    ok: true,
    mode: r.mode,
    plan: activePlan.remaining.length ? activePlan : null,
    ...sequenceState(activePlan.remaining.length ? activePlan : null),
    done: !activePlan.remaining.length
  };
}

// 顺序发送下一条：只在该组方案还有剩余消息时可用。
async function applyNext(id) {
  const s = getCurrent();
  if (!s || s.id !== id) return { ok: false, error: '建议不存在或已失效' };
  const activePlan = s.activePlan;
  if (!activePlan || !activePlan.remaining.length) {
    return { ok: false, error: '没有待发送的下一条' };
  }

  const text = activePlan.remaining[0];
  const r = await deliver(s, text);
  if (!r.ok) return { ...r, plan: activePlan, ...sequenceState(activePlan) };

  const next = {
    ...activePlan,
    sent: [...activePlan.sent, text],
    remaining: activePlan.remaining.slice(1)
  };
  setActivePlan(id, next.remaining.length ? next : null);
  return {
    ok: true,
    mode: r.mode,
    plan: next.remaining.length ? next : null,
    ...sequenceState(next.remaining.length ? next : null),
    done: !next.remaining.length
  };
}

// 放弃当前顺序，回到方案选择态。
function resetSequence(id) {
  const s = getCurrent();
  if (!s || s.id !== id) return { ok: false, error: '建议不存在或已失效' };
  setActivePlan(id, null);
  return { ok: true };
}

module.exports = { applyPlan, applyNext, resetSequence, describeFailure };
