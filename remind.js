// 小鹈鹕 V3 — 主动提醒（CLI 壳，逻辑在 core/remind/runner）
'use strict';

const { runReminders } = require('./core/remind/runner');

const DRY_RUN = process.argv.includes('--dry-run');

runReminders({ dryRun: DRY_RUN })
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[remind] 异常', e);
    process.exit(1);
  });
