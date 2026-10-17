'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initializeRuntime, selectWritableDirectory } = require('../core/lib/startup');
const { waitForCore } = require('../core/lib/readiness');

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tinypelican-startup-'));
}

test('startup bootstrap creates config and writable DSH home without overwriting config', () => {
  const root = tempDirectory();
  fs.writeFileSync(path.join(root, 'config.example.json'), '{"created":true}');
  const env = {};
  const result = initializeRuntime({ root, env, home: root, warn: () => {} });
  assert.equal(result.dataDir, root);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')), { created: true });
  fs.writeFileSync(path.join(root, 'config.json'), '{"custom":true}');
  initializeRuntime({ root, env, home: root, warn: () => {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')), { custom: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('startup bootstrap falls back when the preferred directory cannot be written', () => {
  const root = tempDirectory();
  const fallback = tempDirectory();
  const blocked = path.join(root, 'blocked');
  const fakeFs = {
    ...fs,
    mkdirSync(directory, options) {
      if (path.resolve(directory) === path.resolve(blocked)) {
        const error = new Error('denied');
        error.code = 'EACCES';
        throw error;
      }
      return fs.mkdirSync(directory, options);
    }
  };
  assert.equal(selectWritableDirectory([blocked, fallback], { filesystem: fakeFs }), path.resolve(fallback));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(fallback, { recursive: true, force: true });
});

test('core readiness waits for health and validates its source directory', async () => {
  let attempts = 0;
  const health = { ok: true, name: 'xiaotihu-core', projectRoot: process.cwd(), dataDir: path.join(process.cwd(), 'data') };
  const result = await waitForCore({
    base: 'http://127.0.0.1:18791',
    root: process.cwd(),
    dataDir: health.dataDir,
    timeoutMs: 100,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('not ready');
      return { ok: true, json: async () => health };
    },
    sleep: async () => {}
  });
  assert.equal(result.name, 'xiaotihu-core');
  assert.equal(attempts, 2);
});
