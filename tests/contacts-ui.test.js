'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

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

function setup(handler) {
  const previous = { document: global.document, fetch: global.fetch, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
  const root = new Element('div');
  global.document = { createElement: (tag) => new Element(tag), createTextNode: (text) => ({ nodeType: 3, textContent: text }), getElementById: () => null, body: new Element('body') };
  global.setTimeout = () => 0;
  global.clearTimeout = () => {};
  global.fetch = async (url, options = {}) => new Response(JSON.stringify(await handler(url, options)));
  return { root, restore: () => Object.assign(global, previous) };
}

test('画像卡片展示真实数据、编辑后完整替换保存，数据管理与分析操作分开', async () => {
  let contact = { name: '联系人', remark: '', messages: 8, profile: { 基础身份: { 职业: '学生', 城市: '上海' }, 行为意向: { 爱好: '电影' }, 社交目的及策略: { 社交目的: '保持联系' } }, profileMeta: { updatedAt: '2026-09-26T01:01:59+08:00', source: 'full_history_analysis', confidence: 0.92 } };
  const calls = [];
  let resolveAnalysis;
  const fixture = setup(async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, body });
    if (url === '/api/contacts') return [contact];
    if (url.includes('/messages?')) return { messages: [] };
    if (url.endsWith('/emails')) return { emails: ['contact@example.com'] };
    if (url.endsWith('/chat-summary')) return { chatSummary: { summary: '双方交流工作与生活。', topics: ['2026-09-14｜工作近况：双方交流实习近况。'] }, jobs: [] };
    if (url.endsWith('/analyze-profile')) { await new Promise((resolve) => { resolveAnalysis = resolve; }); return { ok: true, queued: true }; }
    if (url.endsWith('/profile') && body) { contact = { ...contact, profile: body.profile, remark: body.remark }; return { ok: true }; }
    return contact;
  });
  const { root } = fixture;
  let view;
  try {
    const { mount } = await import(mountUrl);
    view = mount(root);
    await settle();
    await byClass(root, 'wechat-contact-item')[0].click();
    await settle();
    const requestsBeforeOpen = calls.filter((entry) => entry.url.includes('/messages?')).length;
    await button(root, '联系人画像').click();
    await settle();
    assert.equal(calls.filter((entry) => entry.url.includes('/messages?')).length, requestsBeforeOpen);
    assert.equal(byClass(root, 'contact-avatar').length, 0);
    assert.equal(byClass(root, 'wechat-msg-avatar').length, 0);
    const preview = byClass(root, 'contact-profile-preview')[0];
    assert.match(preview.textContent, /职业学生/);
    const editors = byClass(root, 'wechat-profile-children')[0];
    assert.equal(editors.hidden, true);
    await button(root, '编辑画像').click();
    assert.equal(editors.hidden, false);
    assert.equal(preview.hidden, true);
    assert.equal(editors.children[0].open, true);
    assert.match(byClass(root, 'wechat-profile-footer')[0].textContent, /来源：完整历史分析/);
    assert.equal(root.all().find((entry) => entry.tagName === 'progress').value, 92);
    assert.match(byClass(root, 'contact-summary-card')[0].textContent, /双方交流工作与生活/);
    assert.match(byClass(root, 'contact-email-list')[0].textContent, /contact@example.com/);
    const actions = byClass(root, 'wechat-profile-actions')[0];
    assert.deepEqual(actions.children.filter((entry) => entry.tagName === 'button').map((entry) => entry.textContent), ['保存画像', '更新分析', '更新联系人画像']);
    assert.deepEqual(byClass(root, 'contact-data-actions')[0].children.map((entry) => entry.textContent), ['清空聊天记录', '删除联系人']);
    const analyze = button(root, '更新联系人画像');
    const generating = analyze.click();
    assert.equal(analyze.disabled, true);
    assert.equal(analyze.textContent, '画像生成中…');
    resolveAnalysis();
    await generating;
    await settle();
    for (const editor of byClass(root, 'wechat-profile-editor')) editor.value = '';
    await button(root, '保存画像').click();
    await settle();
    const saved = calls.find((entry) => entry.url.endsWith('/profile') && entry.body);
    assert.equal(saved.body.profileMode, 'replace');
    assert.ok(Object.values(saved.body.profile).every((section) => Object.keys(section).length === 0));
    assert.match(byClass(root, 'contact-profile-preview')[0].textContent, /暂无画像信息/);
    assert.ok(byClass(root, 'wechat-profile-editor').every((entry) => !/学生|上海|电影|保持联系/.test(entry.value)));
    await button(root, '关闭联系人画像').click();
    assert.equal(button(root, '联系人画像').attributes['aria-expanded'], 'false');
    assert.equal(byClass(root, 'wechat-profile-pane')[0].className.includes('open'), false);
  } finally { view?.hide(); fixture.restore(); }
});

test('聊天按日分组、合并连续时间，历史加载保持顺序，按已加载日期筛选并导出', async () => {
  const contact = { name: '联系人', messages: 4 };
  const calls = [];
  const fixture = setup(async (url) => {
    calls.push(url);
    if (url === '/api/contacts') return [contact];
    if (url.includes('/messages?')) {
      if (url.includes('before=2026')) return { messages: [{ id: 1, ts: '2026-09-24T12:00:00', name: contact.name, content: '更早的聊天', isOwner: false }], hasMore: false };
      return { messages: [
        { id: 2, ts: '2026-09-25T20:32:00', name: '我', content: '刚想说', isOwner: true },
        { id: 3, ts: '2026-09-25T20:33:00', name: '我', content: '要么就是哪吒', isOwner: true },
        { id: 4, ts: '2026-09-25T20:44:00', name: contact.name, content: '[图片]', type: 'image', isOwner: false }
      ], hasMore: true };
    }
    return contact;
  });
  let view;
  const originalCreate = URL.createObjectURL;
  let exported;
  URL.createObjectURL = (blob) => { exported = blob; return 'blob:contact-test'; };
  try {
    const { mount } = await import(mountUrl);
    view = mount(fixture.root);
    await settle();
    await byClass(fixture.root, 'wechat-contact-item')[0].click();
    await settle();
    assert.equal(byClass(fixture.root, 'contact-date-divider').length, 1);
    assert.equal(byClass(fixture.root, 'wechat-msg-body').flatMap((entry) => entry.children.filter((child) => child.tagName === 'time')).length, 2);
    assert.equal(byClass(fixture.root, 'continued').length, 1);
    assert.match(byClass(fixture.root, 'contact-image-placeholder')[0].textContent, /原图暂不可用/);
    assert.equal(fixture.root.all().filter((entry) => entry.tagName === 'img').length, 0);
    await button(fixture.root, '查看更多聊天记录').click();
    assert.deepEqual(byClass(fixture.root, 'wechat-bubble').map((entry) => entry.textContent), ['更早的聊天', '刚想说', '要么就是哪吒', '图片原图暂不可用']);
    assert.equal(byClass(fixture.root, 'contact-date-divider').length, 2);
    assert.equal(button(fixture.root, '查看更多聊天记录'), undefined);
    const filter = byClass(fixture.root, 'contact-date-filter')[0];
    filter.value = '2026-09-24';
    filter.onchange();
    assert.equal(byClass(fixture.root, 'wechat-msg-row').length, 1);
    assert.equal(calls.filter((url) => url.includes('/messages?')).length, 2);
    await button(fixture.root, '导出记录').click();
    const exportText = await exported.text();
    assert.match(exportText, /更早的聊天/);
    assert.doesNotMatch(exportText, /刚想说/);
    assert.equal(fixture.root.all().some((entry) => entry.tagName === 'textarea'), false);
  } finally { view?.hide(); URL.createObjectURL = originalCreate; fixture.restore(); }
});

test('快速切换联系人不会显示旧请求结果，待确认与失败状态不伪装成完成', async () => {
  const contacts = [{ name: '较慢的联系人' }, { name: '当前联系人', profile: {} }];
  let resolveSlow;
  const fixture = setup(async (url) => {
    if (url === '/api/contacts') return contacts;
    if (url.endsWith(encodeURIComponent(contacts[0].name))) return new Promise((resolve) => { resolveSlow = resolve; });
    if (url.includes('/messages?')) return { messages: [{ ts: '2026-09-25T20:44:00', isOwner: false, content: '当前消息' }] };
    if (url.endsWith('/chat-summary')) return { chatSummary: {}, jobs: [{ kind: 'summary', status: 'failed', error: '连接失败' }, { kind: 'profile', status: 'idle', intentId: 'pending-profile' }] };
    if (url.endsWith('/emails')) return { emails: [] };
    return contacts[1];
  });
  let view;
  try {
    const { mount } = await import(mountUrl);
    view = mount(fixture.root);
    await settle();
    const items = byClass(fixture.root, 'wechat-contact-item');
    await items[0].click();
    await settle();
    await items[1].click();
    await settle();
    resolveSlow(contacts[0]);
    await settle();
    assert.match(byClass(fixture.root, 'wechat-chat-title')[0].textContent, /当前联系人/);
    assert.equal(byClass(fixture.root, 'wechat-bubble')[0].textContent, '当前消息');
    await button(fixture.root, '联系人画像').click();
    await settle();
    assert.match(byClass(fixture.root, 'contact-profile-empty')[0].textContent, /画像候选已生成/);
    assert.match(byClass(fixture.root, 'contact-profile-card')[0].textContent, /待确认/);
    assert.match(byClass(fixture.root, 'contact-summary-card')[0].textContent, /失败/);
    assert.doesNotMatch(byClass(fixture.root, 'contact-summary-card')[0].textContent, /已完成/);
    assert.match(byClass(fixture.root, 'contact-memory-state')[0].textContent, /连接失败/);
  } finally { view?.hide(); fixture.restore(); }
});
