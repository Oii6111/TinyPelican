// 小鹈鹕核心 — 消息去重
'use strict';

const { msgKey } = require('../memory/stores/contacts');

function dedupeBatch(msgs, existingKeys = new Set()) {
  const seen = new Set(existingKeys);
  const fresh = [];
  for (const m of msgs || []) {
    const k = msgKey(m);
    if (seen.has(k)) continue;
    seen.add(k);
    fresh.push(m);
  }
  return fresh;
}

module.exports = { dedupeBatch };
