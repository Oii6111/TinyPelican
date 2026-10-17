// 小鹈鹕核心 — 响应模型与规范化（对应参考项目 src/api/models）
'use strict';

function maskKey(s) {
  const str = String(s || '');
  if (!str) return '';
  if (str.length <= 8) return '****';
  return str.slice(0, 3) + '****' + str.slice(-4);
}

function maskConfig(cur) {
  const out = JSON.parse(JSON.stringify(cur || {}));
  const provs = out.engine && out.engine.providers;
  if (provs && typeof provs === 'object') {
    for (const k of Object.keys(provs)) {
      if (provs[k] && provs[k].apiKey) provs[k].apiKey = maskKey(provs[k].apiKey);
    }
  }
  const bark = out.notify && out.notify.bark;
  if (out.email?.imap?.password) out.email.imap.password = maskKey(out.email.imap.password);
  if (out.email?.smtp?.password) out.email.smtp.password = maskKey(out.email.smtp.password);
  if (out.webSearch?.moonshot?.apiKey) out.webSearch.moonshot.apiKey = maskKey(out.webSearch.moonshot.apiKey);
  if (bark && bark.key) bark.key = maskKey(bark.key);
  return out;
}

// POST 设置时，打码后的 Key 不回写（保留原值）
function restoreMaskedKeys(cur, patch) {
  if (typeof patch.webSearch?.moonshot?.apiKey === 'string' && patch.webSearch.moonshot.apiKey.includes('****')) {
    patch.webSearch.moonshot.apiKey = cur.webSearch?.moonshot?.apiKey || '';
  }
  const provs = patch.engine && patch.engine.providers;
  if (provs && typeof provs === 'object') {
    const curProvs = cur.engine && cur.engine.providers;
    for (const k of Object.keys(provs)) {
      const pv = provs[k];
      if (pv && typeof pv === 'object' && typeof pv.apiKey === 'string' && pv.apiKey.includes('****')) {
        if (curProvs && curProvs[k]) pv.apiKey = curProvs[k].apiKey;
        else delete pv.apiKey;
      }
    }
  }
  const bark = patch.notify && patch.notify.bark;
  if (bark && typeof bark.key === 'string' && bark.key.includes('****')) {
    const curBark = cur.notify && cur.notify.bark;
    if (curBark && curBark.key) bark.key = curBark.key;
    else delete bark.key;
  }
  for (const protocol of ['imap', 'smtp']) {
    const value = patch.email && patch.email[protocol] && patch.email[protocol].password;
    if (typeof value === 'string' && value.includes('****')) {
      const current = cur.email && cur.email[protocol];
      if (current && current.password) patch.email[protocol].password = current.password;
      else delete patch.email[protocol].password;
    }
  }
}

module.exports = { maskKey, maskConfig, restoreMaskedKeys };
