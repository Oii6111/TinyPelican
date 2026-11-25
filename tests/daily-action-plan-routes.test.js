'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const calls = [];
  let handler;
  let result = { ok: true, contactName: '小雨', plan: { steps: [] } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../core/api/routes/daily-action-plans.js'), 'utf8'), {
    module, URL, require: () => ({ open: async (id, options) => { calls.push({ id, recreate: options.recreate }); return result; } })
  });
  module.exports({ post: (route, callback) => {
    assert.equal(route, '/api/daily-actions/:id/plan');
    handler = callback;
  } }, { readBody: async request => request.body, json: (response, status, body) => ({ status, body }) });
  return { calls, setResult: value => { result = value; },
    request: (body = '{}', headers = {}) => handler({ body, headers: { host: '127.0.0.1:18791', ...headers } }, { setHeader() {} }, {}, { id: 'action-one' }) };
}

test('plan endpoint validates requests before starting a model-backed generation', async () => {
  const state = fixture();
  for (const body of ['bad json', 'null', '[]', '{"recreate":"true"}']) assert.equal((await state.request(body)).status, 400);
  assert.equal((await state.request('{}', { origin: 'https://other.example' })).status, 403);
  assert.equal((await state.request('{}', { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal(state.calls.length, 0);
});

test('plan endpoint returns generated plans and preserves explicit recreation and error status', async () => {
  const state = fixture();
  const opened = await state.request();
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.body.plan, { steps: [] });
  state.setResult({ ok: false, status: 502, error: '详细计划暂时无法生成' });
  const failed = await state.request();
  assert.equal(failed.status, 502);
  state.setResult({ ok: true, plan: { steps: [] } });
  await state.request('{"recreate":true}');
  assert.deepEqual(state.calls, [{ id: 'action-one', recreate: false }, { id: 'action-one', recreate: false }, { id: 'action-one', recreate: true }]);
});
