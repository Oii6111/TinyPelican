'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.nodeType = 1;
    this.className = ''; this.textContent = ''; this.value = ''; this.style = {};
    this.classList = { add: (name) => { this.className += ' ' + name; }, remove: (name) => { this.className = this.className.split(' ').filter((item) => item !== name).join(' '); }, toggle: (name, enabled) => enabled ? this.classList.add(name) : this.classList.remove(name) };
  }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(key, value) { this.attributes[key] = value; if (key === 'value') this.value = value; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  dispatch(name, event = {}) { for (const callback of this.listeners[name] || []) callback(event); }
  all() { return [this, ...this.children.filter((child) => child instanceof Element).flatMap((child) => child.all())]; }
  querySelector(selector) {
    const segments = selector.split(' ');
    const first = this.all().find((element) => segments[0].startsWith('.') ? element.className.split(' ').includes(segments[0].slice(1)) : element.tagName === segments[0]);
    return segments.length > 1 ? first?.querySelector(segments.slice(1).join(' ')) || null : first || null;
  }
  getBoundingClientRect() { return { height: 420 }; }
  focus() { global.document.activeElement = this; }
  setSelectionRange() {}
}

test('新话题先展开四方向而不请求生成；选择、来源、回填与重试分离', async () => {
  const previous = { document: global.document, window: global.window, fetch: global.fetch, setInterval: global.setInterval };
  const root = new Element('div');
  let suggestion = { id: 'first', contact: '联系人', sourceMessage: '你好', mode: 'reply', plans: [{ tone: '自然', messages: ['你好呀'] }] };
  const calls = [];
  let fail = false;
  global.document = { getElementById: () => root, createElement: (tag) => new Element(tag), createTextNode: (text) => ({ nodeType: 3, textContent: text }), activeElement: null };
  global.window = { addEventListener() {} };
  global.setInterval = () => 0;
  global.fetch = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, body });
    if (url.endsWith('/current')) return new Response(JSON.stringify({ suggestion, pending: null }));
    if (url.endsWith('/new-topic')) {
      if (fail) return new Response(JSON.stringify({ ok: false, error: '联网失败，请重试', suggestion }));
      suggestion = { ...suggestion, id: 'topic', mode: 'new_topic', direction: body.direction, plans: [{ tone: '分享', messages: ['这件事还挺有意思的'], sources: [{ id: 'source-1', title: '来源事件', url: 'https://example.com', publishedAt: null }] }] };
      return new Response(JSON.stringify({ ok: true, suggestion }));
    }
    return new Response(JSON.stringify({ ok: true, suggestion }));
  };
  const settle = async () => { for (let pass = 0; pass < 5; pass++) await new Promise(setImmediate); };
  const button = (text) => root.all().find((node) => node.tagName === 'button' && node.textContent === text);
  try {
    await import(pathToFileURL(path.resolve(__dirname, '../dashboard/src/suggestion-card.mjs')).href);
    await settle();
    button('💡 开始新话题').dispatch('click');
    assert.ok(button('随便聊聊') && button('聊点新鲜的') && button('更了解对方') && button('回顾历史'));
    assert.equal(calls.filter((call) => call.url.endsWith('/new-topic')).length, 0);
    button('聊点新鲜的').dispatch('click');
    await settle();
    assert.deepEqual(calls.find((call) => call.url.endsWith('/new-topic')).body, { direction: 'fresh', deep: false });
    const source = root.all().find((node) => node.tagName === 'a');
    assert.match(source.textContent, /发布时间未知/);
    let stopped = false;
    source.dispatch('click', { stopPropagation: () => { stopped = true; } });
    assert.equal(stopped, true);
    assert.equal(calls.some((call) => call.url.endsWith('/apply')), false);
    root.querySelector('.plan').dispatch('click');
    await settle();
    assert.deepEqual(calls.find((call) => call.url.endsWith('/apply')).body, { plan: 0 });
    fail = true;
    button('💡 开始新话题').dispatch('click');
    button('聊点新鲜的').dispatch('click');
    await settle();
    assert.ok(button('重试聊点新鲜的'));
    assert.ok(button('随便聊聊'));
    assert.match(root.querySelector('.msg-text').textContent, /这件事/);
  } finally { Object.assign(global, previous); }
});
