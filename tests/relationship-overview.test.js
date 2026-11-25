'use strict';

// 联系人「关系概览」：接口层（指标 / 群与群成员拒绝 / 无消息）与视图层（概览字段、编辑保存、排序）。
// 产品口径是泛社交关系维护，不做关系判断，也不产出话术或建议。

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pelican-relationship-'));
process.env.XIAOTIHU_DATA_DIR = directory;
const { createServer } = require('../core/server');
const chat = require('../core/memory/chat-db');
after(() => {
  chat.db.close();
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---------- 接口层 ----------

async function startServer() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function stopServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

const postJson = (base, url, body) => fetch(base + url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

test('关系概览接口：联系人返回指标与阶段/备忘，群与群成员被拒，无消息不报错', async () => {
  const name = '林小满';
  chat.ingestMessages(name, [
    { name: '我', ts: '2026-11-18T09:00:00Z', content: '早呀', isOwner: true },
    { name, ts: '2026-11-18T09:10:00Z', content: '早上好', isOwner: false },
    { name, ts: '2026-11-18T09:12:00Z', content: '今天要开会', isOwner: false },
    { name: '我', ts: '2026-11-18T09:30:00Z', content: '几点？', isOwner: true },
    { name, ts: '2026-11-19T10:00:00Z', content: '在吗', isOwner: false },
    { name: '我', ts: '2026-11-19T10:20:00Z', content: '在的', isOwner: true },
    { name: '我', ts: '2026-11-24T21:00:00Z', content: '周末有空吗', isOwner: true },
    { name, ts: '2026-11-24T21:30:00Z', content: '有的', isOwner: false }
  ]);
  chat.ingestMessages('项目群', [{ name: '我', ts: '2026-11-20T10:00:00Z', content: '群消息', isOwner: true }], { kind: 'group' });
  chat.linkGroupMembers('项目群', ['群里的阿俊']);
  // 只有联系人行、没有任何消息：接口不该报错，metrics 必须是 null
  chat.ingestMessages('刚认识的人', []);

  const { server, base } = await startServer();
  const encoded = (value) => encodeURIComponent(value);
  const readRelationship = async (value) => fetch(base + '/api/contacts/' + encoded(value) + '/relationship');
  const relationship = async (value) => (await readRelationship(value)).json();
  try {
    // 复用画像接口保存「阶段 / 备忘 / 社交目的」
    const saved = await postJson(base, '/api/contacts/' + encoded(name) + '/profile', {
      relationship: '同事',
      notes: '约好周末一起看展',
      socialGoal: '保持工作上的联系'
    });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.equal(savedBody.stage, '同事');
    assert.equal(savedBody.notes, '约好周末一起看展');
    assert.equal(savedBody.socialGoal, '保持工作上的联系');

    const response = await readRelationship(name);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.name, name);
    assert.equal(body.kind, 'contact');
    assert.equal(body.stage, '同事');
    assert.equal(body.notes, '约好周末一起看展');
    assert.equal(body.socialGoal, '保持工作上的联系');
    assert.ok(body.metrics, '有聊天记录时必须带指标');
    assert.equal(body.metrics.sample.includedRows, 8);
    assert.equal(body.metrics.sample.totalSessions, 3);
    assert.equal(body.metrics.initiation.ownerCount, 2);
    assert.equal(body.metrics.initiation.contactCount, 1);
    assert.equal(body.metrics.messageBalance.totalMessages, 8);
    assert.equal(body.metrics.replyLatency.contact.medianMs, 1200000);
    assert.equal(Object.hasOwn(body.metrics.initiation, 'diagnosis'), false);
    assert.ok(body.metrics.interpretationGuardrails.some((text) => text.includes('不判定')));
    assert.equal(body.recent.messages, 8);
    assert.match(String(body.recent.lastMessageAt), /2026-11-24/);
    assert.ok(Number.isInteger(body.recent.daysSinceLast) && body.recent.daysSinceLast >= 0);

    // 只改一个字段：另一个字段不能被清空
    const partial = await postJson(base, '/api/contacts/' + encoded(name) + '/profile', { notes: '周末改到下午' });
    assert.equal(partial.status, 200);
    const afterPartial = await relationship(name);
    assert.equal(afterPartial.stage, '同事');
    assert.equal(afterPartial.notes, '周末改到下午');
    assert.equal(afterPartial.socialGoal, '保持工作上的联系');

    // 类型不对明确拒绝，不写库
    const invalid = await postJson(base, '/api/contacts/' + encoded(name) + '/profile', { relationship: 123 });
    assert.equal(invalid.status, 400);
    assert.equal((await relationship(name)).stage, '同事');

    // 原有的画像保存行为不变，且不会覆盖关系维护字段
    const profileSaved = await postJson(base, '/api/contacts/' + encoded(name) + '/profile', { profile: { 基础身份: { 城市: '杭州' } } });
    assert.equal(profileSaved.status, 200);
    assert.deepEqual((await profileSaved.json()).profile, { 基础身份: { 城市: '杭州' } });
    const afterProfile = await relationship(name);
    assert.equal(afterProfile.stage, '同事');
    assert.equal(afterProfile.notes, '周末改到下午');
    assert.equal(afterProfile.socialGoal, '保持工作上的联系');

    // 群 / 群成员不是联系人：明确拒绝
    const group = await readRelationship('项目群');
    assert.equal(group.status, 400);
    assert.match((await group.json()).error, /群/);
    const member = await readRelationship('群里的阿俊');
    assert.equal(member.status, 400);
    const listed = await (await fetch(base + '/api/contacts')).json();
    assert.ok(!listed.some((item) => item.name === '项目群' || item.name === '群里的阿俊'), '联系人列表不包含群和群成员');

    // 没有消息时不报错，metrics 为 null
    const empty = await relationship('刚认识的人');
    assert.equal(empty.metrics, null);
    assert.equal(empty.recent.messages, 0);
    assert.equal(empty.recent.lastMessageAt, '');
    assert.equal(empty.recent.daysSinceLast, null);
    assert.equal(empty.stage, '');
    assert.equal(empty.notes, '');

    // 不存在的联系人
    assert.equal((await readRelationship('查无此人')).status, 404);
  } finally { await stopServer(server); }
});

// ---------- 视图层 ----------

// 与 tests/contacts-ui.test.js 同一套 DOM 桩：只实现视图用到的节点能力。
class Element {
  constructor(tag) {
    this.tagName = tag; this.nodeType = 1; this.children = []; this.listeners = {}; this.attributes = {};
    this.className = ''; this.value = ''; this.open = false; this.hidden = false; this.disabled = false;
    this.scrollTop = 0; this.scrollHeight = 100; this.parent = null; this._text = '';
    this.classList = { toggle: (name, enabled) => {
      const names = this.className.split(' ').filter((entry) => entry && entry !== name);
      if (enabled) names.push(name);
      this.className = names.join(' ');
    } };
  }
  get textContent() { return this._text + this.children.map((child) => child.textContent || '').join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...children) {
    for (const child of children) {
      child.remove?.();
      child.parent = this;
      this.children.push(child);
    }
  }
  prepend(...children) { for (const child of children.reverse()) { child.remove?.(); child.parent = this; this.children.unshift(child); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
  replaceChildren(...children) { this._text = ''; this.children = []; this.append(...children); }
  setAttribute(name, value) {
    this.attributes[name] = value;
    if (name === 'value') this.value = value;
    if (['open', 'hidden', 'disabled'].includes(name)) this[name] = true;
  }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  async click() { if (this.disabled) return; if (this.onclick) await this.onclick(); for (const callback of this.listeners.click || []) await callback({}); }
  all() { return [this, ...this.children.filter((entry) => entry instanceof Element).flatMap((entry) => entry.all())]; }
  focus() {}
}

const settle = async () => { for (let pass = 0; pass < 10; pass++) await new Promise(setImmediate); };
const mountUrl = pathToFileURL(path.resolve(__dirname, '../dashboard/src/views/contacts.mjs')).href;
const byClass = (root, name) => root.all().filter((entry) => entry.className.split(' ').includes(name));
const button = (root, label) => root.all().find((entry) => entry.tagName === 'button' && (entry.attributes['aria-label'] === label || entry.textContent === label));
// 取某一行事实的 <dd> 文本（例如「消息量」→「8 条」），断言精确值而不靠整段拼接文本。
const factValue = (root, label) => {
  const term = root.all().find((node) => node.tagName === 'dt' && node.textContent === label);
  return term?.parent?.children.find((node) => node.tagName === 'dd')?.textContent;
};

function viewFixture(handler) {
  const previous = { document: global.document, fetch: global.fetch, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
  const root = new Element('div');
  global.document = { createElement: (tag) => new Element(tag), createTextNode: (text) => ({ nodeType: 3, textContent: text }), getElementById: () => null, body: new Element('body') };
  global.setTimeout = () => 0;
  global.clearTimeout = () => {};
  global.fetch = async (url, options = {}) => {
    const result = await handler(url, options);
    return result instanceof Response ? result : new Response(JSON.stringify(result));
  };
  return { root, restore: () => Object.assign(global, previous) };
}

const contactItemNames = (root) => byClass(root, 'wechat-contact-item').map((item) => item.all().find((node) => node.tagName === 'strong').textContent);

test('联系人列表默认顺序不变，可按关系指标排序且每个联系人只拉一次概览', async () => {
  const contacts = [{ name: '阿澈' }, { name: '小满' }, { name: '老周' }];
  const relationshipOf = (overrides) => ({
    kind: 'contact', socialGoal: '', stage: '', notes: '',
    metrics: { initiation: { ownerShare: 0.5, contactShare: 0.5 }, replyLatency: { owner: { medianMs: null }, contact: { medianMs: null } }, messageBalance: { totalMessages: 0 }, sample: { includedRows: 0, totalSessions: 0 } },
    recent: { lastMessageAt: '', messages: 0, daysSinceLast: null },
    ...overrides
  });
  const relationships = {
    阿澈: relationshipOf({ name: '阿澈', recent: { lastMessageAt: '2026-11-25T08:00:00Z', messages: 12, daysSinceLast: 0 }, metrics: { initiation: { ownerShare: 0.2, contactShare: 0.8 }, replyLatency: { owner: { medianMs: null }, contact: { medianMs: 900000 } }, messageBalance: { totalMessages: 12 }, sample: { includedRows: 12, totalSessions: 5 } } }),
    小满: relationshipOf({ name: '小满', recent: { lastMessageAt: '2026-11-20T08:00:00Z', messages: 30, daysSinceLast: 5 }, metrics: { initiation: { ownerShare: 0.8, contactShare: 0.2 }, replyLatency: { owner: { medianMs: null }, contact: { medianMs: 300000 } }, messageBalance: { totalMessages: 30 }, sample: { includedRows: 30, totalSessions: 6 } } }),
    老周: relationshipOf({ name: '老周', recent: { lastMessageAt: '2026-11-01T08:00:00Z', messages: 3, daysSinceLast: 24 }, metrics: { initiation: { ownerShare: 0.5, contactShare: 0.5 }, replyLatency: { owner: { medianMs: null }, contact: { medianMs: 7200000 } }, messageBalance: { totalMessages: 3 }, sample: { includedRows: 3, totalSessions: 2 } } })
  };
  const calls = [];
  const fixture = viewFixture(async (url) => {
    calls.push(String(url));
    if (url === '/api/contacts') return contacts;
    const relationMatch = String(url).match(/^\/api\/contacts\/(.+)\/relationship$/);
    if (relationMatch) return relationships[decodeURIComponent(relationMatch[1])];
    if (String(url).includes('/messages?')) return { messages: [] };
    if (String(url).endsWith('/chat-summary')) return { chatSummary: {}, jobs: [] };
    if (String(url).endsWith('/emails')) return { emails: [] };
    if (String(url).endsWith('/profile')) return { ok: true };
    return contacts.find((contact) => url === '/api/contacts/' + encodeURIComponent(contact.name)) || contacts[0];
  });
  const relationshipRequests = () => calls.filter((url) => url.endsWith('/relationship')).length;
  let view;
  try {
    const { mount } = await import(mountUrl);
    view = mount(fixture.root);
    await settle();
    assert.deepEqual(contactItemNames(fixture.root), ['阿澈', '小满', '老周'], '默认保持接口原有顺序');
    const sortSelect = byClass(fixture.root, 'contact-sort')[0];
    assert.ok(sortSelect, '联系人列表要有排序下拉');
    assert.equal(sortSelect.value, '');
    const pick = async (value) => { sortSelect.value = value; await sortSelect.onchange(); await settle(); };

    await pick('messages');
    assert.deepEqual(contactItemNames(fixture.root), ['小满', '阿澈', '老周']);
    await pick('recent');
    assert.deepEqual(contactItemNames(fixture.root), ['阿澈', '小满', '老周']);
    await pick('initiation');
    assert.deepEqual(contactItemNames(fixture.root), ['小满', '老周', '阿澈']);
    await pick('latency');
    assert.deepEqual(contactItemNames(fixture.root), ['小满', '阿澈', '老周']);
    assert.equal(relationshipRequests(), 3, '每个联系人只统计一次');

    await pick('');
    assert.deepEqual(contactItemNames(fixture.root), ['阿澈', '小满', '老周']);
    assert.equal(relationshipRequests(), 3, '切回默认排序不再补请求');
  } finally { view?.hide(); fixture.restore(); }
});

test('联系人详情展示关系概览，阶段与备忘可编辑并保存到画像接口', async () => {
  const contact = { name: '小满', remark: '', messages: 8 };
  const relationship = {
    name: '小满', kind: 'contact', socialGoal: '互相分享日常', stage: '老同学', notes: '约好周末看展',
    metrics: {
      initiation: { ownerCount: 2, contactCount: 1, ownerShare: 2 / 3, contactShare: 1 / 3 },
      replyLatency: { owner: { medianMs: 1140000 }, contact: { medianMs: 1200000 } },
      messageBalance: { totalMessages: 8 },
      sample: { includedRows: 8, totalSessions: 3, limitation: '回复间隔只表示消息间隔，不代表已读。' }
    },
    recent: { lastMessageAt: '2026-11-24T21:30:00Z', messages: 8, daysSinceLast: 0 }
  };
  const calls = [];
  const fixture = viewFixture(async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url: String(url), body });
    if (url === '/api/contacts') return [contact];
    if (String(url).endsWith('/relationship')) return relationship;
    if (String(url).includes('/messages?')) return { messages: [] };
    if (String(url).endsWith('/chat-summary')) return { chatSummary: {}, jobs: [] };
    if (String(url).endsWith('/emails')) return { emails: [] };
    if (String(url).endsWith('/profile') && body) return { ok: true, stage: body.relationship.trim(), notes: body.notes.trim() };
    return contact;
  });
  const relationshipRequests = () => calls.filter((entry) => entry.url.endsWith('/relationship')).length;
  let view;
  try {
    const { mount } = await import(mountUrl);
    view = mount(fixture.root);
    await settle();
    assert.equal(relationshipRequests(), 0, '没打开联系人详情前不做统计');
    await byClass(fixture.root, 'wechat-contact-item')[0].click();
    await settle();
    await button(fixture.root, '联系人画像').click();
    await settle();
    assert.equal(relationshipRequests(), 1);

    const card = byClass(fixture.root, 'contact-relationship-card')[0];
    assert.ok(card, '详情里要有关系概览卡片');
    assert.match(card.textContent, /关系概览/);
    assert.match(factValue(card, '最近联系'), /2026/);
    assert.equal(factValue(card, '消息量'), '8 条');
    assert.equal(factValue(card, '发起比例'), '我 67% · 对方 33%（3 段会话）');
    assert.equal(factValue(card, '回复延迟中位数'), '对方 20 分钟 · 我 19 分钟');
    assert.equal(factValue(card, '社交目的'), '互相分享日常');
    assert.equal(factValue(card, '阶段'), '老同学');
    assert.equal(factValue(card, '备忘'), '约好周末看展');
    assert.match(byClass(card, 'contact-relationship-facts')[0].textContent, /仅统计最近 8 条消息/);

    const stage = byClass(card, 'contact-relationship-stage')[0];
    const notes = byClass(card, 'contact-relationship-notes')[0];
    assert.equal(stage.value, '老同学');
    assert.equal(notes.value, '约好周末看展');

    stage.value = '朋友';
    notes.value = '换了工作，聊新公司';
    await button(card, '保存阶段与备忘').click();
    await settle();
    const saved = calls.find((entry) => entry.url.endsWith('/profile') && entry.body);
    assert.deepEqual(saved.body, { relationship: '朋友', notes: '换了工作，聊新公司' });
    assert.equal(factValue(card, '阶段'), '朋友');
    assert.equal(factValue(card, '备忘'), '换了工作，聊新公司');

    // 卡片可折叠；重新打开详情用缓存，不再请求接口
    await button(card, '收起关系概览').click();
    assert.equal(byClass(card, 'contact-relationship-body')[0].hidden, true);
    await button(card, '展开关系概览').click();
    assert.equal(byClass(card, 'contact-relationship-body')[0].hidden, false);
    await button(fixture.root, '联系人画像').click();
    await settle();
    await button(fixture.root, '联系人画像').click();
    await settle();
    assert.equal(relationshipRequests(), 1, '关系概览按联系人缓存');
  } finally { view?.hide(); fixture.restore(); }
});

test('没有聊天记录的详细页只显示暂无记录提示，指标为占位且不报错', async () => {
  const contact = { name: '刚认识的人', remark: '', messages: 0 };
  const fixture = viewFixture(async (url) => {
    if (url === '/api/contacts') return [contact];
    if (String(url).endsWith('/relationship')) return { name: '刚认识的人', kind: 'contact', socialGoal: '', stage: '', notes: '', metrics: null, recent: { lastMessageAt: '', messages: 0, daysSinceLast: null } };
    if (String(url).includes('/messages?')) return { messages: [] };
    if (String(url).endsWith('/chat-summary')) return { chatSummary: {}, jobs: [] };
    if (String(url).endsWith('/emails')) return { emails: [] };
    return contact;
  });
  let view;
  try {
    const { mount } = await import(mountUrl);
    view = mount(fixture.root);
    await settle();
    await byClass(fixture.root, 'wechat-contact-item')[0].click();
    await settle();
    await button(fixture.root, '联系人画像').click();
    await settle();
    const card = byClass(fixture.root, 'contact-relationship-card')[0];
    assert.equal(factValue(card, '最近联系'), '暂无聊天记录');
    assert.equal(factValue(card, '消息量'), '0 条');
    assert.equal(factValue(card, '发起比例'), '—');
    assert.equal(factValue(card, '回复延迟中位数'), '—');
    assert.equal(factValue(card, '阶段'), '未填写');
    assert.match(byClass(card, 'contact-relationship-facts')[0].textContent, /暂无聊天记录：录到消息后这里会自动统计/);
  } finally { view?.hide(); fixture.restore(); }
});
