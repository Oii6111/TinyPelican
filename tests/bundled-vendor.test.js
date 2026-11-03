'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { optimizeVendor } = require('../app/optimize-bundled-vendor.cjs');

test('identical vendor copies share resolution while differing copies remain local', context => {
  const content = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-dedupe-'));
  context.after(() => fs.rmSync(content, { recursive: true, force: true }));
  const scope = path.join(content, 'vendor', 'node_modules', '@deepseek-ai');
  for (const [name, value] of [['first', 1], ['second', 1], ['different', 2]]) {
    const directory = path.join(scope, name, 'node_modules', 'zod');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'zod', version: '1.0.0', main: 'index.js' }));
    fs.writeFileSync(path.join(directory, 'index.js'), `module.exports = ${value};`);
  }
  assert.equal(optimizeVendor(content), 2);
  assert.equal(optimizeVendor(content), 0);
  for (const [name, expected] of [['first', 1], ['second', 1], ['different', 2]]) {
    assert.equal(createRequire(path.join(scope, name, 'package.json'))('zod'), expected);
  }
});
