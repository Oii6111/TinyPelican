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
  return out;
}

// POST 设置时，打码后的 Key 不回写（保留原值）
function restoreMaskedKeys(cur, patch) {
  const provs = patch.engine && patch.engine.providers;
  if (!provs || typeof provs !== 'object') return;
  const curProvs = cur.engine && cur.engine.providers;
  for (const k of Object.keys(provs)) {
    const pv = provs[k];
    if (pv && typeof pv === 'object' && typeof pv.apiKey === 'string' && pv.apiKey.includes('****')) {
      if (curProvs && curProvs[k]) pv.apiKey = curProvs[k].apiKey;
      else delete pv.apiKey;
    }
  }
}

module.exports = { maskKey, maskConfig, restoreMaskedKeys };
