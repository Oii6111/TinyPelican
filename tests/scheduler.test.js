'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { Scheduler } = require('../core/remind/scheduler');

test('定时任务按间隔执行', async () => {
  const s = new Scheduler();
  let count = 0;
  s.register({ name: 't', intervalMs: 80, run: async () => { count += 1; } });
  s.start();
  await new Promise((r) => setTimeout(r, 250));
  s.stop();
  assert.ok(count >= 2, 'expected >=2 runs, got ' + count);
});
