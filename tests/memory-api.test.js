'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pelican-memory-api-'));
process.env.XIAOTIHU_DATA_DIR = directory;
const { createServer } = require('../core/server');
const chat = require('../core/memory/chat-db');
const { saveIntents } = require('../core/memory/stores/intents');
after(() => { chat.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

test('画像模板、队列状态、手动重建、候选编辑确认/拒绝与设置脱敏验证', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    chat.ingestMessages('联系人', [{ name: '联系人', ts: new Date().toISOString(), type: 'text', content: '我平时爱打球' }]);
    const template = await (await fetch(base + '/api/profile-template')).json();
    assert.equal(template.length, 7);
    const rebuilt = await post('/api/contacts/联系人/chat-summary/rebuild');
    assert.equal(rebuilt.status, 202);
    const analyzed = await post('/api/contacts/联系人/analyze-profile');
    assert.equal(analyzed.status, 202);
    const status = await (await fetch(base + '/api/contacts/联系人/chat-summary')).json();
    assert.ok(status.jobs.some((job) => job.kind === 'profile' && job.status === 'pending'));
    assert.deepEqual(chat.getMember('联系人').profile, {});
    await post('/api/contacts/联系人/profile', { profile: { 行为意向: { 饮品: '手动值' } }, profileSkipped: ['interests:游戏'] });
    const profile = await (await fetch(base + '/api/contacts/联系人/profile')).json();
    assert.equal(profile.gaps.find((field) => field.id === 'interests:游戏').state, 'skipped');
    saveIntents([{ id: 'candidate', type: 'profile_update', contact: '联系人', status: 'pending_confirm', profilePatch: { 行为意向: { 运动: '足球' } } }]);
    await post('/api/intents/candidate', { profilePatch: { 行为意向: { 运动: '篮球' } } });
    assert.equal(chat.getMember('联系人').profile.行为意向.运动, undefined);
    assert.equal((await (await post('/api/intents/candidate/confirm')).json()).ok, true);
    assert.deepEqual(chat.getMember('联系人').profile.行为意向, { 饮品: '手动值', 运动: '篮球' });
    saveIntents([{ id: 'reject', type: 'profile_update', contact: '联系人', status: 'pending_confirm', profilePatch: { 行为意向: { 运动: '足球' } } }]);
    await post('/api/intents/reject', { status: 'rejected' });
    assert.equal(chat.getMember('联系人').profile.行为意向.运动, '篮球');
    const secret = 'test-secret-only-in-config';
    const saved = await (await post('/api/settings', { webSearch: { moonshot: { apiKey: secret } }, profileAutoUpdate: { enabled: true, days: 30, scope: 'all' } })).json();
    assert.ok(!JSON.stringify(saved).includes(secret));
    await post('/api/settings', { webSearch: { moonshot: { apiKey: saved.webSearch.moonshot.apiKey } } });
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'config.json'))).webSearch.moonshot.apiKey, secret);
    assert.equal((await post('/api/settings', { profileAutoUpdate: { days: 8 } })).status, 400);
    assert.equal((await post('/api/settings', { webSearch: { timeoutMs: 0 } })).status, 400);
    assert.equal((await post('/api/settings', { engine: { providers: { custom: { thinkingBody: { model: 'wrong' } } } } })).status, 400);
    const searchStatus = await (await fetch(base + '/api/web-search/status')).json();
    assert.equal(searchStatus.enabled, false);
    assert.equal((await post('/api/web-search/test')).status, 502);
    assert.equal((await fetch(base + '/api/contacts/联系人/messages', { method: 'DELETE' })).status, 200);
    assert.deepEqual(chat.getMember('联系人').chatSummary, {});
    assert.equal((await post('/api/contacts/联系人/analyze-profile')).status, 400);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test('手工完整保存支持删除字段、清空板块及全部画像，不恢复旧社交目的', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(base + '/api/contacts/清空画像/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const read = async () => (await fetch(base + '/api/contacts/清空画像/profile')).json();
  try {
    chat.ingestMessages('清空画像', [{ name: '清空画像', content: '你好' }]);
    await post({ remark: '保留备注', profileSkipped: ['interests:游戏'], profile: {
      基础身份: { 职业: '学生', 城市: '上海' }, 行为意向: { 爱好: '电影' }, 社交目的及策略: { 社交目的: '保持联系' }, 旧自由字段: '待删除'
    } });
    assert.equal((await read()).socialGoal, '保持联系');
    const saved = await post({ profileMode: 'replace', profile: { 基础身份: { 职业: '学生' }, 行为意向: {} } });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).profile, { 基础身份: { 职业: '学生' }, 行为意向: {} });
    let contact = await read();
    assert.deepEqual(contact.profile, { 基础身份: { 职业: '学生' }, 行为意向: {} });
    assert.equal(contact.socialGoal, '');
    assert.equal(contact.remark, '保留备注');
    assert.deepEqual(contact.profileSkipped, ['interests:游戏']);
    await post({ profileMode: 'replace', profile: {} });
    contact = await read();
    assert.deepEqual(contact.profile, {});
    assert.equal(contact.socialGoal, '');
    assert.equal(chat.getMember('清空画像').socialGoal, '');
    await post({ profile: { 基础身份: { 城市: '杭州' } } });
    await post({ profile: { 基础身份: { 职业: '实习' } } });
    assert.deepEqual((await read()).profile, { 基础身份: { 城市: '杭州', 职业: '实习' } });
    for (const body of [{ profileMode: 'unknown', profile: {} }, { profileMode: 'replace' }, { profileMode: 'replace', profile: [] }]) {
      assert.equal((await post(body)).status, 400);
    }
    assert.deepEqual((await read()).profile, { 基础身份: { 城市: '杭州', 职业: '实习' } });
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
