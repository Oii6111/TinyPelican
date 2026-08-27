// 小鹈鹕 V3 — 关系维护检查（CLI 壳，逻辑在 core/memory/relations）
'use strict';

const { runRelationCheck } = require('./core/memory/relations');

runRelationCheck()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[relation] 异常', e);
    process.exit(1);
  });
