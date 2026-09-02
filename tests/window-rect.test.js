'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseLine } = require('../core/capture/window-rect');

test('window-rect 输出解析', () => {
  assert.deepStrictEqual(parseLine('OK 29884 465 163 2589 1800 168'), {
    pid: '29884',
    bounds: { left: 465, top: 163, right: 2589, bottom: 1800 },
    dpi: 168
  });

  assert.strictEqual(parseLine('FAIL'), null);
  assert.strictEqual(parseLine('OK 0 0 0 0 0 0'), null);
  assert.strictEqual(parseLine('OK 1 100 100 200 200 0').pid, '1');
  assert.deepStrictEqual(parseLine('OK 1 100 100 200 200 0').bounds, {
    left: 100,
    top: 100,
    right: 200,
    bottom: 200
  });
});
