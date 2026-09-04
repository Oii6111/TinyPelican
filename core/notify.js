// 小鹈鹕核心 — 统一主动通知入口
// 支持微信 iLink 与 Bark；通过 config.notify.mode 选择：
//   - weixin            ：只用微信
//   - weixin-then-bark  ：微信优先，不可用/发送失败时用 Bark 兜底
//   - bark              ：只用 Bark
//   - off               ：关闭主动通知
'use strict';

const { loadConfig } = require('./lib/config');
const { pushToUser } = require('./channels/weixin/push');

function pick(v) {
  return v === undefined || v === null || v === '' ? undefined : v;
}

async function sendBark({ title = '小鹈鹕', message = '', config = null } = {}) {
  const cfg = config || loadConfig();
  const bark = (cfg.notify && cfg.notify.bark) || {};
  const key = String(bark.key || '').trim();
  if (!key) return { ok: false, error: '未配置 Bark Key', channel: 'bark' };
  const server = String(bark.server || 'https://api.day.app').replace(/\/+$/, '');

  const payload = {
    device_key: key,
    title,
    body: String(message || ''),
    subtitle: pick(bark.subtitle),
    level: pick(bark.level),
    sound: pick(bark.sound),
    icon: pick(bark.icon),
    group: pick(bark.group),
    url: pick(bark.url),
    copy: pick(bark.copy),
    autoCopy: bark.autoCopy ? '1' : undefined,
    call: bark.call ? '1' : undefined,
    isArchive: bark.isArchive ? '1' : undefined
  };
  const badge = parseInt(bark.badge, 10);
  if (Number.isFinite(badge) && badge > 0) payload.badge = badge;
  for (const k of Object.keys(payload)) {
    if (payload[k] === undefined) delete payload[k];
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`${server}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data.code !== undefined && data.code !== 200)) {
      return { ok: false, error: `Bark HTTP ${res.status} code=${data.code || ''} ${data.message || ''}`, channel: 'bark' };
    }
    return { ok: true, channel: 'bark', data };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), channel: 'bark' };
  } finally {
    clearTimeout(timer);
  }
}

async function notifyUser({ title = '小鹈鹕', message = '', config = null } = {}) {
  const cfg = config || loadConfig();
  const mode = (cfg.notify && cfg.notify.mode) || 'weixin';

  if (mode === 'off') return { ok: false, error: '通知已关闭', channel: 'none' };

  let weixinError = '';
  if (mode === 'weixin' || mode === 'weixin-then-bark') {
    const r = await pushToUser(message, { config: cfg });
    if (r) return { ok: true, channel: 'weixin' };
    weixinError = '微信推送不可用';
    if (mode === 'weixin') return { ok: false, error: weixinError, channel: 'weixin' };
  }

  if (mode === 'bark' || mode === 'weixin-then-bark') {
    const r = await sendBark({ title, message, config: cfg });
    if (r.ok) return r;
    return {
      ok: false,
      error: weixinError ? `${weixinError}；Bark：${r.error || '发送失败'}` : (r.error || 'Bark 发送失败'),
      channel: 'bark'
    };
  }

  return { ok: false, error: '未知通知模式：' + mode, channel: 'none' };
}

module.exports = { notifyUser, sendBark };
