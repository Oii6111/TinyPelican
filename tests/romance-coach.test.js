'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.XIAOTIHU_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pelican-coach-'));
const coach = require('../core/agent/romance-coach');
const base = { relationship: { stage: '了解中', goal: '好好沟通' }, contact: { name: '测试联系人' }, recentMessages: [{ isOwner: true, content: '最近还好吗' }, { isOwner: false, content: '有点累' }] };

test('coaching carries contact context and follow-ups, with isolated persistent histories', async () => {
  let prompt;
  const transport = async input => { prompt = input; return { ok: true, text: '先问问对方是否愿意聊聊。' }; };
  assert.equal((await coach.send({ ...base, message: '怎么回复', transport })).ok, true);
  assert.match(prompt.text, /有点累/);
  assert.match(prompt.text, /好好沟通/);
  assert.ok(prompt.sessionId.startsWith('romance-coach-'));
  await coach.send({ ...base, message: '再短一些', transport });
  assert.match(prompt.text, /怎么回复/);
  assert.match(prompt.text, /先问问对方/);
  assert.equal(coach.history(base.contact.name).length, 4);
  await coach.send({ ...base, contact: { name: '另一位' }, message: '开始', transport });
  assert.doesNotMatch(prompt.text, /再短一些/);
  assert.equal(coach.history('另一位').length, 2);
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.XIAOTIHU_DATA_DIR, 'conversations.json'), 'utf8'));
  assert.equal(saved['romance:coach:测试联系人'].length, 4);
});

test('failure preserves history and never exposes runtime stacks; retry writes only one pair', async () => {
  const before = coach.history(base.contact.name).length;
  const result = await coach.send({ ...base, message: '失败后重试', transport: async () => ({ ok: false, error: 'file:///private/path Error: profile tinypelican does not exist\n at loadProfile' }) });
  assert.equal(result.status, 502);
  assert.doesNotMatch(result.error, /file:|loadProfile|tinypelican/);
  assert.equal(coach.history(base.contact.name).length, before);
  await coach.send({ ...base, message: '失败后重试', transport: async () => ({ ok: true, text: '回复' }) });
  assert.equal(coach.history(base.contact.name).length, before + 2);
});

test('simultaneous requests for the same contact cannot interleave', async () => {
  let finish;
  const running = coach.send({ ...base, message: '第一条', transport: () => new Promise(resolve => { finish = resolve; }) });
  const rejected = await coach.send({ ...base, message: '第二条', transport: async () => { throw new Error('must not run'); } });
  assert.equal(rejected.status, 409);
  finish({ ok: true, text: '完成' });
  assert.equal((await running).ok, true);
});
