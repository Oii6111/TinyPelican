'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

class Element {
  constructor(tag) {
    this.tag = tag;
    this.nodeType = 1;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.scrollLeft = 0;
    this.value = '';
    this.open = false;
    this.disabled = false;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children.map(child => child?.nodeType ? child : { nodeType: 3, textContent: String(child) }); }
  setAttribute(key, value) {
    this.attributes[key] = value;
    if (key === 'open' || key === 'disabled') this[key] = true;
  }
  getAttribute(key) { return this.attributes[key]; }
  addEventListener(key, handler) { this.listeners[key] = handler; }
  all() { return [this, ...this.children.filter(child => child instanceof Element).flatMap(child => child.all())]; }
  set textContent(value) { this.text = value; if (this.tag === 'textarea') this.value = value; }
  get textContent() { return this.text; }
}

const settle = async () => { for (let pass = 0; pass < 12; pass++) await new Promise(setImmediate); };

async function fixture(context, initial) {
  const previous = { document: global.document, fetch: global.fetch, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
  const requests = [];
  const timers = new Map();
  const listeners = new Map();
  let data = initial;
  let failFeedback = false;
  let feedbackErrorStatus = 500;
  let goalDelay = null;
  global.document = {
    visibilityState: 'visible',
    createElement: tag => new Element(tag),
    createTextNode: text => ({ nodeType: 3, textContent: text }),
    addEventListener: (key, handler) => listeners.set(key, handler),
    removeEventListener: key => listeners.delete(key)
  };
  global.setTimeout = (handler, delay) => { const key = Symbol(); timers.set(key, { handler, delay }); return key; };
  global.clearTimeout = key => timers.delete(key);
  global.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, body });
    if (url === '/api/daily-actions') return Response.json(data);
    if (url.endsWith('/generate')) {
      // 服务端行为：换一批/单点强刷会 force 重算，联系人先进入 queued，模型跑完才回结果
      for (const contact of data.contacts) {
        if (contact.status === 'missing' || (body.contactName && contact.contactName === body.contactName) || body.reshuffle) contact.status = 'queued';
      }
      return Response.json({ ok: true }, { status: 202 });
    }
    if (url.endsWith('/feedback')) {
      if (failFeedback) return Response.json({ error: feedbackErrorStatus === 409 ? '推荐已更新，请刷新后再操作。' : '保存失败' }, { status: feedbackErrorStatus });
      const id = url.split('/').at(-2);
      data.contacts.flatMap(contact => contact.actions).find(action => action.id === id).status = body.status;
      return Response.json({ ok: true });
    }
    if (url.endsWith('/plan')) {
      return Response.json({ ok: true, cached: false, plan: {
        steps: [
          { title: '先确认对方最近的安排', detail: '等一个自然的时机，问问她这周忙不忙，不要一上来就约时间。', say: '最近工作还顺利吗？' },
          { title: '接住电影这个话题', detail: '从她提到的那部电影问一个开放式问题，再自然转到线下。', say: '你上次说的那部，后来去看了吗？' }
        ],
        branches: [{ when: '对方积极回应', how: '顺势提一个具体时间，给她留出拒绝空间。' }],
        cautions: ['对方说忙就先停，不追问第二次。']
      } });
    }
    if (url.startsWith('/api/contacts/')) {
      if (goalDelay) await goalDelay;
      const name = decodeURIComponent(url.split('/').at(-2));
      const contact = [...data.contacts, ...(data.goalMissing?.contacts || [])].find(item => item.contactName === name);
      contact.goal = body.socialGoal;
      contact.missingGoal = !body.socialGoal;
      contact.hasNewData = true;
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected endpoint: ${url}`);
  };
  const { mountDailyActions } = await import('../dashboard/src/components/daily-actions.mjs');
  const view = mountDailyActions({ navigate: () => {} });
  context.after(() => { view.hide(); Object.assign(global, previous); });
  return {
    view, requests, timers, listeners,
    setData(value) { data = value; },
    failFeedback(status = 500) { failFeedback = true; feedbackErrorStatus = status; },
    delayGoal(promise) { goalDelay = promise; },
    find: key => view.element.all().find(node => node.attributes['data-daily-control'] === key),
    text: value => view.element.all().find(node => node.textContent?.includes(value))
  };
}

function sample(status = 'ready') {
  return { date: '2026-11-15', contacts: [
    { contactName: '小雨', label: '小雨', goal: '', missingGoal: true, status, generatedAt: '2026-11-15T08:00:00', actions: status === 'missing' ? [] : [
      { id: 'rain-action', status: 'pending', kind: 'topic', title: '聊聊最近看的电影', summary: '接着她昨天提到的电影，问一个轻松的问题。', reason: '最近主动分享了感兴趣的电影。', evidence: [{ type: 'message', label: '小雨', text: '<script>原文只作为文本展示</script>' }] }
    ] },
    { contactName: '小夏', label: '夏夏', goal: '了解共同兴趣', status: 'error', error: '模型暂时不可用', actions: [] }
  ] };
}

test('daily cards preserve contacts, show evidence and open the detailed plan inline', async context => {
  const fixtureState = await fixture(context, sample());
  const { view, requests, find, text } = fixtureState;
  view.show();
  await settle();
  assert.ok(text('聊聊最近看的电影'));
  assert.ok(text('夏夏'));
  assert.ok(text('模型暂时不可用'));
  assert.ok(text('<script>原文只作为文本展示</script>'));
  assert.equal(view.element.all().some(node => node.tag === 'script'), false);
  assert.equal(requests.some(request => request.url.endsWith('/generate')), false);
  await find('plan:rain-action').listeners.click();
  await settle();
  assert.equal(requests.some(request => request.url.endsWith('/plan')), true);
  assert.ok(text('先确认对方最近的安排'));
  assert.ok(text('对方说忙就先停'));
});

test('daily actions generate missing contacts once and stop polling while hidden', async context => {
  const { view, requests, timers, listeners } = await fixture(context, sample('missing'));
  view.show();
  view.show();
  await settle();
  assert.equal(requests.filter(request => request.url.endsWith('/generate')).length, 1);
  assert.equal([...timers.values()][0].delay, 2000);
  await [...timers.values()][0].handler();
  assert.equal(requests.filter(request => request.url.endsWith('/generate')).length, 1);
  view.hide();
  assert.equal(timers.size, 0);
  assert.equal(listeners.size, 0);
});

test('feedback can be completed and undone and failures do not hide the action', async context => {
  const { view, find, text, failFeedback } = await fixture(context, sample());
  view.show();
  await settle();
  await find('done:rain-action').listeners.click();
  assert.ok(text('已完成'));
  assert.equal(find('done:rain-action'), undefined);
  await find('undo:rain-action').listeners.click();
  assert.ok(find('done:rain-action'));
  failFeedback();
  await find('dismiss:rain-action').listeners.click();
  assert.ok(text('保存失败'));
  assert.ok(find('done:rain-action'));
});

test('editing a social goal preserves the daily recommendation until an explicit refresh', async context => {
  const { view, find, text, requests } = await fixture(context, sample());
  view.show();
  await settle();
  find('goal:小雨').value = '这周约一次散步';
  await find('save:goal:小雨').listeners.click();
  assert.ok(text('社交目的：这周约一次散步'));
  assert.ok(text('有新资料'));
  assert.ok(text('聊聊最近看的电影'));
  assert.equal(requests.some(request => request.url.endsWith('/generate')), false);
  await find('generate:小雨').listeners.click();
  assert.deepEqual(requests.find(request => request.url.endsWith('/generate')).body, { contactName: '小雨', force: true });
});

test('feedback on a replaced recommendation refreshes the card instead of claiming success', async context => {
  const { view, find, text, setData, failFeedback } = await fixture(context, sample());
  view.show();
  await settle();
  const complete = find('done:rain-action');
  const updated = sample();
  updated.contacts[0].actions[0].id = 'new-rain-action';
  updated.contacts[0].actions[0].title = '新的建议';
  setData(updated);
  failFeedback(409);
  await complete.listeners.click();
  assert.equal(find('done:rain-action'), undefined);
  assert.ok(find('done:new-rain-action'));
  assert.ok(text('推荐已更新'));
});

test('没行动的联系人不在列表里占行，两句汇总也不显示；原因和补填目的收进折叠区', async context => {
  const data = { date: '2026-11-15', contacts: [
    { contactName: '小雨', label: '小雨', goal: '了解共同兴趣', status: 'ready', actions: [
      { id: 'rain-action', status: 'pending', kind: 'topic', title: '聊聊最近看的电影', summary: '接着昨天的话题。', reason: '她主动分享了电影。', evidence: [] }
    ] },
    { contactName: '小夏', label: '夏夏', goal: '', missingGoal: true, status: 'resting',
      emptyReason: '还没填社交目的，这里暂不生成今日行动；填了之后会按目的安排节奏。', actions: [] },
    { contactName: '阿岚', label: '阿岚', goal: '保持老朋友的日常问候', status: 'resting',
      emptyReason: '间隔：约每 3 天一次；2 天前刚给过建议，今天先不打扰。', actions: [] }
  ], goalMissing: { count: 1, contacts: [
    { contactName: '小林', label: '小林', goal: '', missingGoal: true, interval: 'unset',
      status: 'resting', emptyReason: '还没填社交目的，这里暂不生成今日行动；填了之后会按目的安排节奏。', actions: [] }
  ] } };
  const { view } = await fixture(context, data);
  view.show();
  await settle();
  const nodes = view.element.all();
  const textOf = node => node.textContent || '';
  const list = nodes.find(node => node.className === 'daily-actions-list');
  // 列表里只剩真正的待办，静止的人一行都不占
  assert.equal(list.children.filter(node => node.className === 'daily-list-status').length, 0);
  assert.equal(nodes.some(node => /夏夏：|阿岚：|小林：/.test(textOf(node))), false);
  // 「还有 N 位没填目的」「另外 N 位今天按节奏先不打扰」这两句都不再显示
  assert.equal(nodes.some(node => /位联系人没填社交目的|位今天按节奏先不打扰/.test(textOf(node))), false);
  // 但信息没丢：原因还在「推荐设置与依据」里，没填目的的人也能在那里补填
  assert.ok(nodes.some(node => textOf(node).includes('2 天前刚给过建议')));
  assert.ok(nodes.some(node => textOf(node).includes('还没填社交目的，这里暂不生成今日行动')));
  assert.ok(nodes.some(node => textOf(node).includes('填写社交目的，让建议更贴近你')));
});

test('visible refresh discovers a new local day without intercepting vertical scrolling', async context => {
  const { view, setData, timers, requests } = await fixture(context, sample());
  view.show();
  await settle();
  const next = sample('missing');
  next.date = '2026-11-16';
  setData(next);
  await [...timers.values()][0].handler();
  assert.equal(requests.filter(request => request.url.endsWith('/generate')).length, 1);
  const list = view.element.all().find(node => node.className === 'daily-actions-list');
  assert.ok(list);
  assert.equal(list.listeners.wheel, undefined);
});

test('todo rows omit contact headings and secondary content and never render null text', async context => {
  const data = sample();
  const { view } = await fixture(context, data);
  assert.equal(view.element.children.some(node => node.textContent === 'null'), false);
  view.show();
  await settle();
  const list = view.element.all().find(node => node.className === 'daily-actions-list');
  const row = list.children.find(node => node.className === 'daily-action-row');
  assert.equal(row.children.length, 7);
  // 最后一列是「换一批」图标按钮
  assert.equal(row.children.at(-1).attributes['data-daily-control'], 'reshuffle:rain-action');
  assert.equal(row.children.filter(node => node.textContent === '小雨').length, 1);
  assert.equal(row.all().some(node => node.tag === 'details' || node.tag === 'textarea'), false);
  assert.equal(view.element.all().some(node => node.className === 'daily-contact-label'), false);
  const settings = view.element.children.find(node => node.tag === 'details');
  assert.equal(settings.open, false);
  assert.equal(view.element.children.some(node => node.textContent === 'null'), false);
});

test('social goal input is disabled during save and an unsaved draft survives failed persistence', async context => {
  const { view, find, delayGoal } = await fixture(context, sample());
  view.show();
  await settle();
  let rejectSave;
  delayGoal(new Promise((resolve, reject) => { rejectSave = reject; }));
  const input = find('goal:小雨');
  input.value = '希望先了解彼此';
  input.listeners.input({ target: input });
  const saving = find('save:goal:小雨').listeners.click();
  assert.equal(find('goal:小雨').disabled, true);
  rejectSave(new Error('offline'));
  await saving;
  assert.equal(find('goal:小雨').disabled, false);
  assert.equal(find('goal:小雨').value, '希望先了解彼此');
});

// 换一批是异步的：POST 只返回 202，模型还在跑。这时候就比对必然看到旧结果，
// 于是误报「没换出新的」。结论必须等到队列跑空以后再下。
test('换一批：模型还在跑的时候不能下结论说没换出新的', async context => {
  const state = await fixture(context, sample());
  const { view, find, setData, text } = state;
  view.show();
  await settle();

  await find('reshuffle:all').listeners.click();
  await settle();

  // 后端刚把联系人置为 queued，结果还没出来
  assert.equal(text('这次确实没有更合适的建议'), undefined, '模型还没跑完，不该提前下结论');

  // 模型跑完，换出一条全新的建议
  const done = sample();
  done.contacts[0].actions = [{ id: 'rain-action-new', status: 'pending', kind: 'care',
    title: '问问她面试准备得怎么样', summary: '接着上次提到的面试，给一个具体的关心。', reason: '她最近在准备面试。', evidence: [] }];
  setData(done);
  await find('check').listeners.click();
  await settle();

  assert.equal(text('这次确实没有更合适的建议'), undefined, '换出了新建议就不该再报这句');
  assert.ok(text('问问她面试准备得怎么样'), '新建议应该渲染出来');
});

test('换一批：真的没换出来时，等生成结束后如实说明', async context => {
  const state = await fixture(context, sample());
  const { view, find, setData, text } = state;
  view.show();
  await settle();

  await find('reshuffle:all').listeners.click();
  await settle();
  assert.equal(text('这次确实没有更合适的建议'), undefined);

  // 模型跑完，还是同一条（服务端 reused 了原来的）
  setData(sample());
  await find('check').listeners.click();
  await settle();

  assert.ok(text('这次确实没有更合适的建议'), '确认没换出来时才提示，而且措辞要说清楚是「确实没有」');
});
