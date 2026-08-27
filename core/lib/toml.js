// 小鹈鹕核心 — 极简 TOML 读写（只覆盖本项目用到的扁平 section 字符串键值）
'use strict';

function escapeValue(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function stringifyToml(obj) {
  const lines = [];
  for (const [section, fields] of Object.entries(obj || {})) {
    lines.push(`[${section}]`);
    for (const [k, v] of Object.entries(fields || {})) {
      lines.push(`${k} = "${escapeValue(v)}"`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function parseToml(text) {
  const out = {};
  let section = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sm = line.match(/^\[([^\]]+)\]$/);
    if (sm) {
      section = sm[1];
      out[section] = out[section] || {};
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"$/);
    if (kv && section) out[section][kv[1]] = kv[2];
  }
  return out;
}

module.exports = { stringifyToml, parseToml };
