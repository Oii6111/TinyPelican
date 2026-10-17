'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

class Element {
  constructor(tag) {
    this.tagName = tag; this.nodeType = 1; this.children = []; this.listeners = {}; this.attributes = {};
    this.className = ''; this.textContent = ''; this.value = ''; this.style = {}; this.disabled = false;
    this.classList = { add: (name) => { this.className += ' ' + name; } };
  }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; if (name === 'disabled') this.disabled = true; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  async dispatch(name, event = {}) { for (const callback of this.listeners[name] || []) await callback(event); }
  async click() { if (this.disabled) return; if (this.onclick) await this.onclick(); await this.dispatch('click', { stopPropagation() {} }); }
  focus() {}
  all() { return [this, ...this.children.filter((entry) => entry instanceof Element).flatMap((entry) => entry.all())]; }
}

function installDocument() {
  global.document = { createElement: (tag) => new Element(tag), createTextNode: (text) => ({ nodeType: 3, textContent: text }), getElementById: () => null };
}

const moduleUrl = (filename) => pathToFileURL(path.resolve(__dirname, '../dashboard/src/' + filename)).href;
const settle = async () => { for (let pass = 0; pass < 8; pass++) await new Promise(setImmediate); };

test('微信附件需点击才上传发送，失败保留选择，重试复用上传，过大文件不请求', async () => {
  const previous = { document: global.document, fetch: global.fetch };
  installDocument();
  const calls = [];
  let resolveUpload;
  let resolveSend;
  let sendAttempts = 0;
  const attachment = { id: 'media_1', name: '截图.png', kind: 'image', size: 4, status: 'ready', url: '/api/wechat/media/media_1', downloadUrl: '/api/wechat/media/media_1?download=1' };
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/wechat/media') {
      await new Promise((resolve) => { resolveUpload = resolve; });
      return new Response(JSON.stringify({ ok: true, attachment }));
    }
    sendAttempts++;
    if (sendAttempts === 1) {
      await new Promise((resolve) => { resolveSend = resolve; });
      return new Response(JSON.stringify({ ok: false, error: '连接断开', textSent: true }), { status: 502 });
    }
    return new Response(JSON.stringify({ ok: true }));
  };
  try {
    const { createWeixinMediaSender } = await import(moduleUrl('components/weixin-media.mjs'));
    const panel = createWeixinMediaSender({ configured: true, media: { images: true, files: true, maxBytes: 104857600 } });
    const input = panel.all().find((entry) => entry.tagName === 'input');
    const note = panel.all().find((entry) => entry.tagName === 'textarea');
    const send = panel.all().find((entry) => entry.textContent === '发送到我的微信');
    const feedback = panel.all().find((entry) => entry.attributes.role === 'status');
    const file = new Blob(['test'], { type: 'image/png' });
    file.name = '截图.png';
    input.files = [file];
    await input.dispatch('change');
    assert.equal(calls.length, 0);
    assert.equal(send.disabled, false);
    note.value = '请查收';
    const sending = send.click();
    assert.equal(send.disabled, true);
    assert.equal(send.textContent, '上传中…');
    assert.equal(calls[0].options.body, file);
    assert.equal(calls[0].options.headers['X-Filename'], encodeURIComponent('截图.png'));
    assert.equal(calls[0].options.headers['Content-Type'], 'image/png');
    await send.click();
    assert.equal(calls.length, 1);
    resolveUpload();
    await settle();
    assert.equal(send.textContent, '发送中…');
    assert.deepEqual(JSON.parse(calls[1].options.body), { attachmentId: 'media_1', text: '请查收' });
    resolveSend();
    await sending;
    assert.match(feedback.textContent, /连接断开/);
    assert.match(feedback.textContent, /说明文字已发送/);
    assert.equal(note.value, '');
    assert.equal(send.disabled, false);
    await send.click();
    assert.deepEqual(JSON.parse(calls[2].options.body), { attachmentId: 'media_1' });
    assert.equal(calls.filter((call) => call.url === '/api/wechat/media').length, 1);
    assert.equal(send.disabled, true);
    assert.equal(note.value, '');
    assert.match(feedback.textContent, /已发送/);
    input.files = [{ name: 'large.zip', size: 104857601 }];
    await input.dispatch('change');
    assert.equal(send.disabled, true);
    assert.match(feedback.textContent, /不能超过/);
    assert.equal(calls.length, 3);
    const disconnected = createWeixinMediaSender({ configured: false });
    assert.ok(disconnected.all().filter((entry) => entry.tagName === 'button').every((entry) => entry.disabled));
  } finally { Object.assign(global, previous); }
});

test('微信附件只渲染本地媒体链接，失败可见，不使用服务器路径', async () => {
  const previous = { document: global.document };
  installDocument();
  try {
    const { renderWeixinAttachments } = await import(moduleUrl('components/weixin-media.mjs'));
    const list = renderWeixinAttachments([
      { name: '<script>file</script>.png', kind: 'image', status: 'ready', url: '/api/wechat/media/safe_1', downloadUrl: '/api/wechat/media/safe_1?download=1' },
      { name: 'external.png', kind: 'image', status: 'ready', url: 'https://example.com/a.png', downloadUrl: 'javascript:alert(1)', path: 'C:/secret.png' },
      { name: 'traversal.png', kind: 'image', status: 'ready', url: '/api/wechat/media/../config' },
      { name: 'missing.pdf', kind: 'file', status: 'failed', error: '下载失败' }
    ]);
    const images = list.all().filter((entry) => entry.tagName === 'img');
    const links = list.all().filter((entry) => entry.tagName === 'a');
    assert.equal(images.length, 1);
    assert.equal(images[0].attributes.src, '/api/wechat/media/safe_1');
    assert.ok(links.every((entry) => /^\/api\/wechat\/media\/safe_1/.test(entry.attributes.href)));
    assert.ok(list.all().some((entry) => entry.textContent === '<script>file</script>.png'));
    assert.ok(list.all().some((entry) => entry.textContent === '下载失败'));
    assert.equal(list.all().some((entry) => entry.textContent.includes('C:/secret')), false);
  } finally { Object.assign(global, previous); }
});

test('对话直接嵌入 DSH：连接状态、切页保留及失败重试', async () => {
  const previous = { document: global.document, fetch: global.fetch, location: global.location };
  installDocument();
  global.location = { hostname: '127.0.0.1' };
  const calls = [];
  let fail = false;
  global.fetch = async (url) => {
    calls.push(url);
    if (url === '/api/agent/webui') return fail
      ? new Response(JSON.stringify({ error: 'DSH 尚未就绪' }), { status: 503 })
      : new Response(JSON.stringify({ url: 'http://127.0.0.1:3080/' }));
    return new Response(JSON.stringify({ ok: true }));
  };
  let view;
  try {
    const { mount } = await import(moduleUrl('views/chat.mjs'));
    const root = new Element('div');
    view = mount(root);
    assert.equal(calls.length, 0);
    await view.show();
    await settle();
    const frame = root.all().find((entry) => entry.tagName === 'iframe');
    const status = root.all().find((entry) => entry.attributes.role === 'status');
    assert.equal(frame.getAttribute('src'), 'http://127.0.0.1:3080/');
    assert.equal(frame.hidden, true);
    await frame.dispatch('load');
    assert.equal(frame.hidden, false);
    assert.equal(status.hidden, true);
    view.hide();
    view.show();
    await settle();
    assert.equal(calls.filter((url) => url === '/api/agent/webui').length, 1);
    await frame.dispatch('error');
    assert.equal(status.hidden, false);
    const retry = root.all().find((entry) => entry.textContent === '重新连接');
    fail = true;
    await retry.click();
    await settle();
    assert.ok(root.all().some((entry) => entry.textContent === 'DSH 尚未就绪'));
    fail = false;
    await retry.click();
    await settle();
    await frame.dispatch('load');
    assert.equal(frame.hidden, false);
    assert.equal(calls.some((url) => url.startsWith('/api/chat') || url.startsWith('/api/conversations')), false);
  } finally { view?.hide(); Object.assign(global, previous); }
});
