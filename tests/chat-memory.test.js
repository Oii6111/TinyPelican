'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pelican-memory-'));
process.env.XIAOTIHU_DATA_DIR = directory;
const chat = require('../core/memory/chat-db');
const archive = require('../core/memory/archive');
let memory = require('../core/memory/chat-memory');
const { readIntents, saveIntents } = require('../core/memory/stores/intents');
const { confirmIntent } = require('../core/engine/intent-actions');
const { TEMPLATE, profileGaps, mergeProfile } = require('../core/memory/profile-template');
const config = { selfNicknames: ['我'], profileAutoUpdate: { enabled: false }, engine: { smallModel: 'small-test' } };
const complete = async () => ({ ok: true, text: JSON.stringify({ summary: '对方分享了周末计划，我回应下次一起出游。', topics: ['周末安排', '后续邀约'] }) });
const message = (content, ts = new Date().toISOString(), name = '联系人') => ({ name, ts, type: 'text', content });
async function drain(jobId, completion = complete) {
  for (let round = 0; round < 100; round++) {
    const job = chat.db.prepare('SELECT * FROM memory_job WHERE id=?').get(jobId);
    if (!job || job.status === 'idle') return;
    assert.equal(await memory.processOnce({ config, complete: completion, jobId }), true, chat.db.prepare('SELECT error FROM memory_job WHERE id=?').get(jobId)?.error);
  }
  assert.fail('任务没有完成');
}
after(() => { chat.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

test('参考模板完整、别名和拒绝状态匹配，商务及用户策略不作为普通缺口', () => {
  assert.equal(TEMPLATE.length, 7);
  const fields = TEMPLATE.flatMap((group) => group.fields);
  assert.ok(fields.length > 110);
  assert.equal(new Set(fields.map((field) => field.id)).size, fields.length);
  assert.ok(fields.every((field) => field.description && field.example && Array.isArray(field.aliases)));
  const gaps = profileGaps({ 基础身份: { 所在地: '杭州', 家庭情况: '不愿透露' }, 行为意向: { 周末偏好: '未知', 音乐: '不适用' } }, ['interests:游戏']);
  assert.equal(gaps.find((field) => field.label === '所在城市').state, 'known');
  assert.equal(gaps.find((field) => field.label === '家庭情况').state, 'skipped');
  assert.equal(gaps.find((field) => field.label === '周末安排').eligible, true);
  assert.equal(gaps.find((field) => field.label === '音乐').eligible, false);
  assert.equal(gaps.find((field) => field.label === '游戏').eligible, false);
  assert.ok(!gaps.some((field) => field.applicable !== 'personal' && field.eligible));
  assert.ok(profileGaps({ 基础身份: { 关系类型: '客户' } }).some((field) => field.applicable === 'business' && field.eligible));
  assert.deepEqual(mergeProfile({ 基础身份: { 城市: '手动城市', 职业: '旧值' } }, { 基础身份: { 职业: '新值' } }), { 基础身份: { 城市: '手动城市', 职业: '新值' } });
});

test('补齐超过500条冷库和热库，按消息分块，重复导入不重新登记任务', async () => {
  const rows = Array.from({ length: 620 }, (_, index) => message('旧话题' + index + '内容'.repeat(45), '2025-01-01T10:00:00.000Z'));
  assert.equal(chat.ingestMessages('全量', rows), 620);
  chat.archiveExpired();
  assert.equal(archive.all('全量').length, 620);
  assert.equal(chat.ingestMessages('全量', [message('新聊天')]), 1);
  memory.initialize();
  const id = 'summary-' + chat.getMember('全量').id;
  let calls = 0;
  await drain(id, async (messages, options) => {
    calls++;
    assert.equal(options.model, 'small-test');
    assert.ok(messages[0].content.length < 14000);
    return complete();
  });
  assert.ok(calls > 5);
  assert.equal(chat.getMember('全量').chatSummary.messageCount, 621);
  assert.equal([...chat.historyPages('全量', 17)].flat().length, 621);
  assert.equal(chat.allMessages('全量').total, 621);
  const before = chat.db.prepare('SELECT * FROM memory_job WHERE id=?').get(id);
  assert.equal(chat.ingestMessages('全量', rows), 0);
  assert.deepEqual(chat.db.prepare('SELECT * FROM memory_job WHERE id=?').get(id), before);
  const first = archive.list('全量', { limit: 100 });
  const next = archive.list('全量', { before: first[0].ts, beforeId: first[0].id, limit: 100 });
  assert.equal(next.length, 100);
  assert.ok(next.at(-1).id < first[0].id);
});

test('处理中新增消息留到下一轮，旧总结原子替换，失败保留并有限重试', async () => {
  chat.ingestMessages('增量', [message('第一条')]);
  const id = 'summary-' + chat.getMember('增量').id;
  await memory.processOnce({ config, jobId: id, complete: async () => {
    chat.ingestMessages('增量', [message('处理中新增')]);
    return complete();
  } });
  assert.equal(chat.getMember('增量').chatSummary.messageCount, 1);
  assert.equal(memory.getStatus('增量').jobs[0].remaining, 1);
  await drain(id);
  assert.equal(chat.getMember('增量').chatSummary.messageCount, 2);
  const saved = chat.getMember('增量').chatSummary;
  chat.ingestMessages('增量', [message('失败后再来')]);
  const failed = async () => ({ ok: false, error: '测试服务暂不可用' });
  for (const offset of [0, 61000, 400000]) await memory.processOnce({ config, jobId: id, complete: failed, now: Date.now() + offset });
  assert.equal(memory.getStatus('增量').jobs[0].status, 'failed');
  assert.deepEqual(chat.getMember('增量').chatSummary, saved);
  assert.equal(memory.getStatus('增量').jobs[0].remaining, 1);
  memory.requestJob('增量');
  await drain(id);
  assert.equal(chat.getMember('增量').chatSummary.messageCount, 3);
});

test('重启恢复 running 任务，清空及删除清除派生状态，空消息返回可操作错误', async () => {
  chat.ingestMessages('恢复', [message('未处理')]);
  const id = 'summary-' + chat.getMember('恢复').id;
  chat.db.prepare("UPDATE memory_job SET status='running' WHERE id=?").run(id);
  delete require.cache[require.resolve('../core/memory/chat-memory')];
  memory = require('../core/memory/chat-memory');
  memory.initialize();
  assert.equal(memory.getStatus('恢复').jobs[0].status, 'pending');
  await drain(id);
  chat.clearMemberMessages('恢复');
  assert.deepEqual(memory.getStatus('恢复'), { chatSummary: {}, jobs: [] });
  assert.throws(() => memory.requestJob('恢复'), /请先导入/);
  const memberId = chat.getMember('全量').id;
  chat.deleteMember('全量');
  assert.equal(archive.exists('全量'), false);
  assert.equal(chat.db.prepare('SELECT COUNT(*) AS total FROM memory_queue WHERE member_id=?').get(memberId).total, 0);
});

test('画像候选仅使用对方原话、去重、确认时按板块字段合并', async () => {
  chat.ingestMessages('画像', [message('我喜欢散步', undefined, '画像'), message('我喜欢游泳', undefined, '我')]);
  chat.updateMember('画像', { profile: { 行为意向: { 饮品: '手动记录咖啡' } } });
  const id = memory.requestJob('画像', 'profile').jobId;
  const analysis = async (messages) => {
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[1].role, 'user');
    assert.ok(!messages.some((entry) => entry.content.includes('我喜欢游泳')));
    const seq = [...messages[1].content.matchAll(/\[(\d+)\] [^\n]+/g)].map((match) => Number(match[1]));
    const ownerSeq = chat.db.prepare("SELECT seq FROM memory_queue WHERE member_id=? AND kind='profile' AND sender='我'").get(chat.getMember('画像').id).seq;
    return { ok: true, text: JSON.stringify({ candidates: [
      { section: '行为意向', field: '运动', value: '散步', messageIds: [seq[0]], confidence: 0.9 },
      { section: '行为意向', field: '运动', value: '游泳', messageIds: [ownerSeq], confidence: 1 },
      { section: '行为意向', field: '混合依据', value: '散步、游泳', messageIds: [seq[0], ownerSeq], confidence: 1 },
      { section: '基础身份', field: '虚构依据', value: '开发者', messageIds: [seq[0], 999999], confidence: 1 },
      { section: '社交目的及策略', field: '目的', value: '越界', messageIds: [seq[0]] }
    ] }) };
  };
  await drain(id, analysis);
  assert.equal(chat.getMember('画像').profile.行为意向.运动, undefined);
  let intents = readIntents().filter((item) => item.contact === '画像');
  assert.equal(intents.length, 1);
  assert.equal(intents[0].status, 'pending_confirm');
  assert.equal(intents[0].profilePatch.行为意向.运动, '散步');
  assert.deepEqual(intents[0].profilePatch, { 行为意向: { 运动: '散步' } });
  assert.equal(intents[0].evidence[0].evidence[0].text, '我喜欢散步');
  memory.requestJob('画像', 'profile');
  await drain(id, analysis);
  assert.equal(readIntents().filter((item) => item.contact === '画像').length, 1);
  const confirmed = await confirmIntent(intents[0].id);
  assert.equal(confirmed.ok, true);
  assert.deepEqual(chat.getMember('画像').profile.行为意向, { 饮品: '手动记录咖啡', 运动: '散步' });
  const rejected = { ...intents[0], id: 'rejected', status: 'rejected', profilePatch: { 行为意向: { 运动: '跳舞' } } };
  saveIntents([...readIntents(), rejected]);
  assert.equal(chat.getMember('画像').profile.行为意向.运动, '散步');
});

test('画像输入只接受联系人明确身份，支持备注、平台标识和历史昵称，并排除本人及未知发送者', async () => {
  chat.ingestMessages('身份昵称', [
    message('我喜欢散步', undefined, ' 身份昵称 '),
    message('我喜欢电影', undefined, '身份备注'),
    message('我在杭州', undefined, '旧昵称'),
    message('我是医学实习生', undefined, 'wxid-profile'),
    message('我开发 AI 产品', undefined, ' 本人 '),
    message('我经常去酒吧', undefined, '未知发送者')
  ]);
  const member = chat.updateMember('身份昵称', { remark: '身份备注', profile: { 基础身份: { 职业: '旧画像误记用户的开发经历' } } });
  chat.db.prepare('UPDATE member SET platform_id=? WHERE id=?').run('wxid-profile', member.id);
  const alias = chat.db.prepare('INSERT INTO member_name_history(member_id,name,start_ts) VALUES(?,?,?)');
  alias.run(member.id, '旧昵称', '2025-01-01');
  alias.run(member.id, '本人', '2025-01-01');
  const id = memory.requestJob('身份备注', 'profile').jobId;
  let calls = 0;
  assert.equal(await memory.processOnce({ config: { ...config, selfNicknames: ['本人'] }, jobId: id, complete: async (messages) => {
    calls++;
    const prompt = messages.map((entry) => entry.content).join('\n');
    assert.ok(prompt.includes('身份昵称') && prompt.includes('身份备注'));
    assert.ok(!prompt.includes('我开发 AI 产品'));
    assert.ok(!prompt.includes('我经常去酒吧'));
    assert.ok(!prompt.includes('旧画像误记用户的开发经历'));
    const seq = [...messages[1].content.matchAll(/\[(\d+)\] /g)].map((match) => Number(match[1]));
    assert.equal(seq.length, 4);
    return { ok: true, text: JSON.stringify({ candidates: [
      { section: '行为意向', field: '运动', value: '散步', messageIds: [seq[0]], confidence: 0.9 },
      { section: '行为意向', field: '影视', value: '电影', messageIds: [seq[1]], confidence: 0.9 },
      { section: '基础身份', field: '所在城市', value: '杭州', messageIds: [seq[2]], confidence: 0.9 },
      { section: '基础身份', field: '职业/学业', value: '医学实习中', messageIds: [seq[3]], confidence: 0.9 }
    ] }) };
  } }), true);
  assert.equal(calls, 1);
  assert.equal(memory.getStatus('身份昵称').jobs.find((job) => job.kind === 'profile').status, 'idle');
  assert.deepEqual(readIntents().find((item) => item.contact === '身份昵称').profilePatch, {
    行为意向: { 运动: '散步', 影视: '电影' }, 基础身份: { 所在城市: '杭州', '职业/学业': '医学实习中' }
  });
});

test('仅本人或未知发送者的画像任务不调用模型，队列仍正常完成', async () => {
  chat.ingestMessages('无对方消息', [message('我正在实习', undefined, '我'), message('我喜欢音乐', undefined, '路人')]);
  const id = memory.requestJob('无对方消息', 'profile').jobId;
  await drain(id, async () => assert.fail('无联系人消息时不应调用模型'));
  const status = memory.getStatus('无对方消息').jobs.find((job) => job.kind === 'profile');
  assert.equal(status.status, 'idle');
  assert.equal(status.remaining, 0);
  assert.ok(!readIntents().some((item) => item.contact === '无对方消息'));
});

test('画像仅保存简短结论，冗长值和聊天依据被过滤，审核依据单独保留', async () => {
  chat.ingestMessages('结论画像', [message('我是临床医学专业的学生，现在正在实习，我生日是9月14日', '2026-09-14T10:00:00.000Z', '结论画像')]);
  chat.updateMember('结论画像', { profile: { 基础身份: { 所在城市: '手动记录上海' } } });
  const id = memory.requestJob('结论画像', 'profile').jobId;
  await drain(id, async (messages) => {
    const seq = Number(messages[1].content.match(/\[(\d+)\] /)[1]);
    return { ok: true, text: JSON.stringify({ candidates: [
      { section: '基础身份', field: '职业/学业', value: ' 学生/医学方向/实习中 ', messageIds: [seq, seq], confidence: 0.95 },
      { section: '基础身份', field: '生日', value: '09-14', messageIds: [seq], confidence: 0.9 },
      { section: '基础身份', field: '冗长职业', value: '职业信息'.repeat(20), messageIds: [seq] },
      { section: '基础身份', field: '叙述职业', value: '2026-09-14提到正在骨科实习', messageIds: [seq] },
      { section: '基础身份', field: '引用依据', value: '学生；依据：在聊天中自述', messageIds: [seq] },
      { section: '基础身份', field: ' __proto__ ', value: '错误字段', messageIds: [seq] }
    ] }) };
  });
  const intent = readIntents().find((item) => item.contact === '结论画像');
  assert.deepEqual(intent.profilePatch, { 基础身份: { '职业/学业': '学生/医学方向/实习中', 生日: '09-14' } });
  assert.equal(intent.evidence[0].evidence.length, 1);
  assert.equal(intent.evidence[0].evidence[0].ts, '2026-09-14T10:00:00.000Z');
  assert.ok(intent.detail.includes('临床医学专业的学生'));
  assert.equal(chat.getMember('结论画像').profile.基础身份['职业/学业'], undefined);
  assert.equal((await confirmIntent(intent.id)).ok, true);
  assert.deepEqual(chat.getMember('结论画像').profile.基础身份, { 所在城市: '手动记录上海', '职业/学业': '学生/医学方向/实习中', 生日: '09-14' });
});

test('自动画像只按7/30天、范围和变化生成，关闭时取消自动任务而保留手动任务', () => {
  for (const name of ['关心', '普通']) chat.ingestMessages(name, [message(name)]);
  chat.updateMember('关心', { important: true });
  const now = Date.now();
  chat.db.prepare('UPDATE memory_state SET last_profile_at=?').run(new Date(now - 8 * 86400000).toISOString());
  memory.scheduleProfiles({ profileAutoUpdate: { enabled: true, days: 30, scope: 'all' } }, now);
  assert.equal(memory.getStatus('关心').jobs.some((job) => job.kind === 'profile'), false);
  memory.scheduleProfiles({ profileAutoUpdate: { enabled: true, days: 7, scope: 'important' } }, now);
  assert.equal(memory.getStatus('关心').jobs.find((job) => job.kind === 'profile').status, 'pending');
  assert.equal(memory.getStatus('普通').jobs.some((job) => job.kind === 'profile'), false);
  memory.requestJob('普通', 'profile');
  memory.scheduleProfiles(config);
  assert.equal(memory.getStatus('关心').jobs.find((job) => job.kind === 'profile').status, 'idle');
  assert.equal(memory.getStatus('普通').jobs.find((job) => job.kind === 'profile').status, 'pending');
});

test('归档写入失败保留热数据；90天边界和失败重试不重复归档', () => {
  const now = Date.now();
  chat.ingestMessages('边界', [message('旧', new Date(now - 91 * 86400000).toISOString()), message('新', new Date(now - 89 * 86400000).toISOString())]);
  const original = archive.append;
  archive.append = () => { throw new Error('模拟归档不可写'); };
  try { assert.throws(() => chat.archiveExpired('边界'), /不可写/); }
  finally { archive.append = original; }
  assert.equal(chat.messages('边界').messages.length, 2);
  chat.archiveExpired('边界');
  chat.archiveExpired('边界');
  assert.equal(chat.messages('边界', '', 100, true).messages[0].content, '新');
  assert.equal(archive.all('边界').length, 1);
});

test('重建或清空发生在模型执行期间时，旧任务结果不会覆盖新任务', async () => {
  chat.ingestMessages('并发重建', [message('一条')]);
  const id = memory.requestJob('并发重建').jobId;
  await memory.processOnce({ config, jobId: id, complete: async () => {
    memory.requestJob('并发重建');
    return complete();
  } });
  assert.deepEqual(chat.getMember('并发重建').chatSummary, {});
  assert.equal(memory.getStatus('并发重建').jobs[0].status, 'pending');
  await drain(id);
  assert.equal(chat.getMember('并发重建').chatSummary.messageCount, 1);
  memory.requestJob('并发重建');
  await memory.processOnce({ config, jobId: id, complete: async () => {
    chat.clearMemberMessages('并发重建');
    return complete();
  } });
  assert.deepEqual(memory.getStatus('并发重建'), { chatSummary: {}, jobs: [] });
});

test('总结使用宏观话题时间线提示词，保留带日期的条目并在增量处理时合并旧总结', async () => {
  chat.ingestMessages('话题时间线', [message('最近换了工作，正在适应新环境', '2026-09-20T10:00:00.000Z')]);
  const id = memory.requestJob('话题时间线').jobId;
  const topic = '2026-09-20｜工作近况：双方围绕工作变化与新环境适应交流。';
  await drain(id, async (messages) => {
    const prompt = messages[0].content;
    assert.match(prompt, /什么时间，双方聊过什么话题/);
    assert.match(prompt, /不要逐条复述消息/);
    assert.match(prompt, /不要把聊天里提到的未来活动日期当成聊天发生日期/);
    assert.match(prompt, /时间未明确/);
    assert.match(prompt, /最多保留20项/);
    assert.match(prompt, /2026-09-20T10:00:00.000Z/);
    return { ok: true, text: JSON.stringify({ summary: '双方主要交流工作与生活近况。', topics: [topic] }) };
  });
  assert.deepEqual(chat.getMember('话题时间线').chatSummary.topics, [topic]);
  chat.ingestMessages('话题时间线', [message('最近周末开始去爬山了', '2026-09-23T10:00:00.000Z')]);
  await drain(id, async (messages) => {
    assert.ok(messages[0].content.includes(topic));
    assert.match(messages[0].content, /不要只总结最后一批/);
    return { ok: true, text: JSON.stringify({ summary: '双方主要交流工作近况与休闲生活。', topics: [topic, '2026-09-23｜休闲生活：双方围绕周末活动与户外兴趣交流。'] }) };
  });
  assert.equal(chat.getMember('话题时间线').chatSummary.topics.length, 2);
});
