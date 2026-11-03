'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_EDITION_ID,
  editionDataDir,
  listEditions,
  readActiveEdition,
  resolveEdition,
  saveActiveEdition
} = require('../core/lib/editions');

const root = path.resolve(__dirname, '..');

test('本地版本包清单包含原版和关系指导版', () => {
  const editions = listEditions(root);
  assert.deepEqual(editions.map(item => item.id).sort(), ['base', 'romance']);
  assert.equal(resolveEdition(root, 'TINYPELICAN-ROMANCE').id, 'romance');
  assert.equal(resolveEdition(root, 'unknown-code'), null);
});

test('版本状态持久化且商业版本使用独立数据目录', () => {
  const stable = fs.mkdtempSync(path.join(os.tmpdir(), 'tinypelican-edition-'));
  const romance = resolveEdition(root, 'romance');
  saveActiveEdition(stable, romance);
  assert.equal(readActiveEdition(stable, root).id, 'romance');
  assert.equal(editionDataDir(stable, romance), path.join(stable, 'editions', 'romance'));
  assert.equal(editionDataDir(stable, resolveEdition(root, DEFAULT_EDITION_ID)), stable);
  fs.rmSync(stable, { recursive: true, force: true });
});
