'use strict';

// 自动画像的周期只由 profileAutoUpdate.days 决定。
// 回归点：旧实现把 days 写死成 7（30 天选项从未生效），后来又加了
// 「profile_revision<=0 就用 1 小时防抖」的分支，让从未生成过画像的联系人
// 绕过配置天数——两者都会让设置项形同虚设。

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pelican-profile-interval-'));
process.env.XIAOTIHU_DATA_DIR = directory;
const chat = require('../core/memory/chat-db');
const memory = require('../core/memory/chat-memory');

after(() => {
  chat.db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

const DAY = 86400000;

function prepare(name) {
  chat.ingestMessages(name, [{ name, ts: new Date().toISOString(), type: 'text', content: '你好' }]);
  const member = chat.getMember(name);
  return {
    member,
    reset() { chat.db.prepare("DELETE FROM memory_job WHERE member_id=? AND kind='profile'").run(member.id); },
    aged(ms) { chat.db.prepare('UPDATE memory_state SET last_profile_at=? WHERE member_id=?').run(new Date(Date.now() - ms).toISOString(), member.id); },
    jobs() { return memory.getStatus(name).jobs.filter(job => job.kind === 'profile'); }
  };
}

function schedule(days, at = Date.now()) {
  return memory.scheduleProfiles({ profileAutoUpdate: { enabled: true, days, scope: 'all' } }, at);
}

test('自动画像严格按配置天数排队：30 天不排、7 天排', () => {
  const { reset, aged, jobs } = prepare('周期一');
  reset();
  aged(8 * DAY);
  schedule(30);
  assert.equal(jobs().length, 0, '30 天周期下，8 天前画像过不该再次排队');
  schedule(7);
  assert.equal(jobs()[0]?.status, 'pending', '换成 7 天周期后应该排队');
});

test('手改配置的天数照办，不被静默改成 7', () => {
  const { reset, aged, jobs } = prepare('周期二');
  reset();
  aged(4 * DAY);
  schedule(3);
  assert.equal(jobs()[0]?.status, 'pending', 'days=3 时 4 天前应到期');
  reset();
  aged(2 * DAY);
  schedule(3);
  assert.equal(jobs().length, 0, 'days=3 时 2 天前不该到期');
});

test('非法或缺失的天数回落 7 天', () => {
  const { reset, aged, jobs } = prepare('周期三');
  for (const days of [0, -1, 'abc', undefined, null, Number.NaN, {}]) {
    reset();
    aged(6 * DAY);
    schedule(days);
    assert.equal(jobs().length, 0, `days=${String(days)} 应回落成 7 天（6 天前还不够）`);
    reset();
    aged(8 * DAY);
    schedule(days);
    assert.equal(jobs()[0]?.status, 'pending', `days=${String(days)} 应回落成 7 天（8 天前该到期）`);
  }
});

test('刚画像过不重排；关闭自动画像会取消已排队的自动任务', () => {
  const { reset, aged, jobs } = prepare('周期四');
  reset();
  aged(0);
  schedule(7);
  assert.equal(jobs().length, 0, '刚画像过不该立刻重排');
  reset();
  aged(9 * DAY);
  schedule(7);
  assert.equal(jobs()[0]?.status, 'pending');
  memory.scheduleProfiles({ profileAutoUpdate: { enabled: false, days: 7, scope: 'all' } });
  assert.equal(jobs().some(job => job.status === 'pending'), false, '关闭后应取消自动任务');
});
