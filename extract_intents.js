// 小鹈鹕 V3 — 意图识别（CLI 壳，逻辑在 core/engine/intent-runner）
'use strict';

const { runIntentExtraction } = require('./core/engine/intent-runner');

runIntentExtraction()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[intent] 异常', e);
    process.exit(1);
  });
