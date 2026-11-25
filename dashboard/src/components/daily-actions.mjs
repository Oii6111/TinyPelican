// 今日行动：按「社交目的 + 客观聊天事实」给每位联系人 1–2 条关系维护建议。
// 组件自己管数据：GET /api/daily-actions 读取，generate / feedback / plan 走对应接口；
// 社交目的复用联系人的 socialGoal 字段（POST /api/contacts/:name/profile）。

import { el, fmtTime } from '../ui.mjs';

const kinds = { reply: '接续聊天', topic: '新话题', invite: '邀约', care: '具体关心', repair: '沟通修复', pause: '留出空间' };

async function request(method, url, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const failure = new Error((data && data.error) || `请求失败（${res.status}）`);
    failure.status = res.status;
    throw failure;
  }
  return data;
}

const daily = {
  list: () => request('GET', '/api/daily-actions'),
  generate: payload => request('POST', '/api/daily-actions/generate', payload),
  feedback: (id, status) => request('POST', `/api/daily-actions/${encodeURIComponent(id)}/feedback`, { status }),
  plan: (id, recreate = false) => request('POST', `/api/daily-actions/${encodeURIComponent(id)}/plan`, { recreate }),
  saveGoal: (name, goal) => request('POST', `/api/contacts/${encodeURIComponent(name)}/profile`, { socialGoal: goal })
};

export function mountDailyActions(ctx) {
  const element = el('section', { class: 'daily-actions', 'aria-label': '今日行动' });
  let state = null;
  let visible = false;
  let revision = 0;
  let timer = null;
  let error = '';
  let signature = '';
  let globalNotice = '';
  const pending = new Set();
  const notices = new Map();
  const drafts = new Map();
  const expanded = new Set();
  const plans = new Map();

  const control = (key, attrs, ...children) => el('button', { type: 'button', 'data-daily-control': key, ...attrs }, ...children);

  function disclosure(key, title, ...children) {
    const details = el('details', { class: 'daily-disclosure', open: expanded.has(key) }, el('summary', { text: title }), ...children);
    details.addEventListener('toggle', () => {
      if (details.open) expanded.add(key);
      else expanded.delete(key);
    });
    return details;
  }

  function schedule() {
    clearTimeout(timer);
    if (!visible || document.visibilityState === 'hidden') return;
    const generating = state?.contacts?.some(contact => ['queued', 'running'].includes(contact.status));
    timer = setTimeout(() => refresh(), generating ? 2000 : 60000);
  }

  async function refresh() {
    if (!visible) return;
    clearTimeout(timer);
    const current = ++revision;
    try {
      let next = await daily.list();
      if (!visible || current !== revision) return;
      // 有新资料只提示，不自动重算：已有建议保持稳定，点更新才重新分析。
      // 只有「还没生成」的联系人才自动补一次（当天第一次进入首页的正常流程）。
      if ((next.contacts || []).some(contact => contact.status === 'missing')) {
        state = next;
        render();
        await daily.generate({});
        if (!visible || current !== revision) return;
        next = await daily.list();
      }
      if (!visible || current !== revision) return;
      // 建议被换掉后，旧的详细计划不再对应任何一条待办，顺手清掉。
      const liveIds = new Set((next.contacts || []).flatMap(contact => (contact.actions || []).map(action => action.id)));
      for (const id of [...plans.keys()]) if (!liveIds.has(id)) plans.delete(id);
      // 换一批：等到队列跑空（没有 queued/running）才下结论。
      // 早一步比对就会看到旧结果，误报「没换出新的」。
      let noticeChanged = false;
      const stillGenerating = (next.contacts || []).some(contact => ['queued', 'running'].includes(contact.status));
      if (reshuffleCheck && !stillGenerating) {
        const after = new Set((next.contacts || []).flatMap(contact => (contact.actions || [])
          .filter(action => action.status === 'pending').map(action => action.id)));
        const { before, action } = reshuffleCheck;
        reshuffleCheck = null;
        const unchanged = action
          ? after.has(action.id)
          : after.size === before.size && [...after].every(id => before.has(id));
        if (unchanged) globalNotice = '这次确实没有更合适的建议，先保留原来的。';
        noticeChanged = true;
      }
      const nextSignature = JSON.stringify(next);
      const changed = signature !== nextSignature || error || noticeChanged;
      state = next;
      signature = nextSignature;
      error = '';
      if (changed) render();
    } catch (failure) {
      if (!visible || current !== revision) return;
      error = failure.message || '暂时无法读取今日行动，请重试。';
      render();
    } finally {
      if (visible && current === revision) schedule();
    }
  }

  async function perform(contact, key, operation) {
    if (pending.has(key)) return;
    pending.add(key);
    notices.delete(contact.contactName);
    ++revision;
    clearTimeout(timer);
    render();
    try {
      await operation();
      await refresh();
    } catch (failure) {
      notices.set(contact.contactName, failure.message || '操作未完成，请重试。');
      if (failure.status === 409 || failure.status === 404) await refresh();
    } finally {
      pending.delete(key);
      if (visible) { render(); schedule(); }
    }
  }

  const pendingIds = () => new Set((state?.contacts || [])
    .flatMap(contact => (contact.actions || []).filter(action => action.status === 'pending').map(action => action.id)));

  function reshuffleBusy() {
    return pending.has('reshuffle:all') || (state?.contacts || []).some(contact => ['queued', 'running'].includes(contact.status));
  }

  // 换一批的结论要等生成真的结束再下：POST /generate 只回 202，模型还在跑。
  // 不等就跑一次 refresh 去比对，看到的必然是旧结果 —— 于是误报「没换出新的」。
  let reshuffleCheck = null;

  async function runReshuffle({ contact = null, action = null } = {}) {
    const key = action ? `reshuffle:${action.id}` : 'reshuffle:all';
    if (pending.has(key)) return;
    pending.add(key);
    globalNotice = '';
    ++revision;
    clearTimeout(timer);
    render();
    const before = pendingIds();
    const avoid = action
      ? [action.title]
      : (state?.contacts || []).flatMap(item => (item.actions || [])
        .filter(entry => entry.status === 'pending').map(entry => entry.title));
    try {
      const payload = { reshuffle: true, avoid };
      if (contact) payload.contactName = contact.contactName;
      reshuffleCheck = { before, action };
      await daily.generate(payload);
      await refresh();
    } catch (failure) {
      reshuffleCheck = null;
      globalNotice = failure.message || '换一批失败，请重试。';
    } finally {
      pending.delete(key);
      if (visible) { render(); schedule(); }
    }
  }

  async function loadPlan(contact, action, recreate = false) {
    const key = `plan:${action.id}`;
    if (pending.has(key)) return;
    pending.add(key);
    notices.delete(contact.contactName);
    render();
    try {
      const result = await daily.plan(action.id, recreate);
      plans.set(action.id, { action, contact, plan: result.plan, cached: result.cached === true });
      expanded.add(`plan:${action.id}`);
    } catch (failure) {
      notices.set(contact.contactName, failure.message || '详细计划暂时无法打开，请重试。');
    } finally {
      pending.delete(key);
      if (visible) render();
    }
  }

  function actionView(contact, action, processed = false) {
    const busy = pending.has(`feedback:${action.id}`);
    const setStatus = status => perform(contact, `feedback:${action.id}`, () => daily.feedback(action.id, status));
    if (processed) return el('div', { class: 'daily-action-row is-processed' },
      el('span', { class: 'daily-action-state', text: action.status === 'done' ? '已完成' : '已忽略' }),
      el('span', { class: 'daily-action-row-title', text: action.title }),
      el('span', { class: 'daily-action-contact', text: contact.label || contact.contactName }),
      control(`plan:${action.id}`, { class: 'btn btn-ghost btn-sm', text: '查看详细计划', onclick: () => loadPlan(contact, action) }),
      control(`undo:${action.id}`, { class: 'btn btn-ghost btn-sm', text: '撤销', disabled: busy, onclick: () => setStatus('pending') }),
      el('span', { class: 'daily-action-spacer' }));
    return el('article', { class: 'daily-action-row', title: action.summary || action.reason || '' },
      el('span', { class: 'daily-action-kind', text: kinds[action.kind] || '今日建议' }),
      el('span', { class: 'daily-action-row-title', text: action.title }),
      el('span', { class: 'daily-action-contact', 'data-daily-control': `contact:${action.id}`, text: contact.label || contact.contactName }),
      control(`done:${action.id}`, { class: 'btn btn-ghost btn-sm', text: '完成', disabled: busy, onclick: () => setStatus('done') }),
      control(`dismiss:${action.id}`, { class: 'btn btn-ghost btn-sm', text: '忽略', disabled: busy, onclick: () => setStatus('dismissed') }),
      control(`plan:${action.id}`, { class: 'btn btn-ghost btn-sm daily-plan-link', text: '查看详细计划', onclick: () => loadPlan(contact, action) }),
      control(`reshuffle:${action.id}`, { class: 'btn btn-ghost btn-sm daily-reshuffle-one', text: '↻',
        title: '换一批：换掉这条建议', 'aria-label': `换掉这条：${action.title}`,
        disabled: busy || pending.has(`reshuffle:${action.id}`) || ['queued', 'running'].includes(contact.status),
        onclick: () => runReshuffle({ contact, action }) }));
  }

  // 间隔 = 社交目的基准 + 客观信号修正，只读展示；模型推断的关系描述不参与这里。
  function intervalText(contact) {
    const days = contact.intervalDays;
    if (days == null) {
      return contact.interval === 'unset' ? '未填社交目的 · 暂不生成' : '间隔：暂停，只在有日程时提醒';
    }
    // 模型判过就直接用它的理由——比公式拼出来的更能解释「为什么是这个数」
    if (contact.cadence?.reason) {
      const clamped = contact.cadence.clamped ? '（被护栏夹进合理区间）' : '';
      return `间隔：${days} 天${clamped} · ${contact.cadence.reason}`;
    }
    const pace = days === 1 ? '每天一次' : `约每 ${days} 天一次`;
    const label = contact.intervalLabel || '';
    const base = contact.intervalBaseDays;
    const reasons = contact.intervalReasons?.length ? `（${contact.intervalReasons.join('、')}）` : '';
    // 基准被客观信号修正过就显示「了解 2 天→约每 1 天一次」，否则只报节奏，别把同一个数字写两遍
    const from = base && base !== days
      ? `${label ? `${label} ` : ''}${base} 天→`
      : (label ? `${label} · ` : '');
    return `间隔：${from}${pace}${reasons}`;
  }

  function goalEditor(contact) {
    const key = `goal:${contact.contactName}`;
    const input = el('textarea', {
      class: 'input daily-goal-input', rows: 2, maxlength: 1000, disabled: pending.has(key),
      'aria-label': `${contact.label || contact.contactName}的社交目的`, 'data-daily-control': key,
      placeholder: '例如：了解对方的兴趣，找机会自然地见面；或：保持老朋友式的日常问候',
      text: drafts.get(key) ?? contact.goal ?? '',
      oninput: event => drafts.set(key, event.target.value)
    });
    return el('div', { class: 'daily-goal-row' },
      el('span', { class: 'daily-goal-label', text: contact.goal ? `社交目的：${contact.goal}` : '未设置社交目的' }),
      contact.gap?.known ? el('span', { class: 'daily-gap-note',
        text: `距上次对话 ${contact.gap.daysSinceLastMessage} 天 · 最后一句是${contact.gap.lastSpeaker}说的` }) : null,
      el('span', { class: 'daily-interval-note', 'data-daily-interval': contact.contactName, text: intervalText(contact) }),
      disclosure(key, contact.missingGoal ? '填写社交目的，让建议更贴近你' : '调整社交目的', input,
      control(`save:${key}`, { class: 'btn btn-sm', text: '保存社交目的', disabled: pending.has(key), onclick: () => perform(contact, key, async () => {
        await daily.saveGoal(contact.contactName, input.value.trim());
        drafts.delete(key);
        expanded.delete(key);
        notices.set(contact.contactName, '社交目的已保存。点「更新推荐」可以按新目的重新分析，间隔也会跟着目的变化。');
      }) })));
  }

  function planView(entry) {
    const key = `plan:${entry.action.id}`;
    const plan = entry.plan || {};
    return disclosure(key, `详细计划 · ${entry.action.title}`,
      el('p', { class: 'daily-plan-cached', text: entry.cached ? '这是之前生成并保存的计划，点「重新生成」可按最新资料重写。' : '' }),
      el('ol', { class: 'daily-plan-steps' }, ...(plan.steps || []).map(step => el('li', { class: 'daily-plan-step' },
        el('strong', { text: step.title }),
        el('p', { text: step.detail }),
        step.say ? el('p', { class: 'daily-plan-say', text: `可以说：${step.say}` }) : null))),
      (plan.branches || []).length ? el('div', { class: 'daily-plan-branches' }, ...plan.branches.map(branch =>
        el('p', { class: 'daily-plan-branch' }, el('strong', { text: branch.when }), `：${branch.how}`))) : null,
      (plan.cautions || []).length ? el('ul', { class: 'daily-plan-cautions' }, ...plan.cautions.map(text => el('li', { text }))) : null,
      control(`plan-recreate:${entry.action.id}`, { class: 'btn btn-ghost btn-sm', text: '重新生成', disabled: pending.has(`plan:${entry.action.id}`),
        onclick: () => loadPlan(entry.contact, entry.action, true) }));
  }

  function contactOptions(contact) {
    const generating = ['queued', 'running'].includes(contact.status);
    const busy = generating || pending.has(`generate:${contact.contactName}`);
    const actions = contact.actions || [];
    const refreshLabel = contact.status === 'error' ? '重试生成' : '更新推荐';
    return el('div', { class: 'daily-contact-options' },
      el('strong', { text: contact.label || contact.contactName }), goalEditor(contact),
      // 今天不打扰的原因不单独占一行，收进这里，需要的时候能翻出来
      contact.emptyReason ? el('p', { class: 'daily-rest-reason', text: contact.emptyReason }) : null,
      contact.hasNewData ? el('p', { class: 'daily-new-data', text: '有新资料，可按需更新今日建议。' }) : null,
      ...actions.filter(action => action.evidence?.length).map(action => disclosure(`evidence:${action.id}`, `${action.title} · 依据`,
        ...action.evidence.map(item => el('div', { class: 'daily-evidence' },
          el('strong', { text: [item.label || '参考资料', item.timestamp ? fmtTime(item.timestamp) : ''].filter(Boolean).join(' · ') }),
          el('p', { text: item.text }))))),
      el('div', { class: 'daily-action-meta' },
      control(`generate:${contact.contactName}`, { class: 'btn btn-ghost btn-sm daily-regenerate', text: busy ? '正在准备…' : refreshLabel,
        disabled: busy,
        onclick: () => perform(contact, `generate:${contact.contactName}`, () => daily.generate({ contactName: contact.contactName, force: true })) })));
  }

  function render() {
    const focused = document.activeElement;
    const focusKey = element.contains?.(focused) ? focused?.getAttribute?.('data-daily-control') : null;
    const selection = focusKey && typeof focused.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null;
    const contacts = state?.contacts || [];
    const entries = contacts.flatMap(contact => (contact.actions || []).map(action => ({ contact, action })));
    const open = entries.filter(({ action }) => action.status === 'pending');
    const processed = entries.filter(({ action }) => action.status !== 'pending');
    // 只有「正在动」和「出错」值得各占一行；今日不出声的人一律不占屏。
    // 这些人的原因（含「还没填社交目的」）收进页面底部的「推荐设置与依据」，需要时翻得到。
    const statusRows = contacts.flatMap(contact => {
      const messages = [];
      if (['queued', 'running'].includes(contact.status)) messages.push('正在准备今日行动…');
      else if (contact.error) messages.push(contact.error);
      if (notices.has(contact.contactName)) messages.push(notices.get(contact.contactName));
      return messages.map(message => el('p', { class: 'daily-list-status',
        role: contact.error ? 'alert' : 'status', text: `${contact.label || contact.contactName}：${message}` }));
    });
    // 没填社交目的的人由服务端摘出 contacts，但他们的输入框得留着——
    // 折叠区就是唯一能补填目的的地方，所以两拨人一起放进去。
    const options = [...contacts, ...(state?.goalMissing?.contacts || [])];
    element.replaceChildren(...[
      el('div', { class: 'social-dash-section-head' },
        el('div', {}, el('h2', { text: '今日行动' }), el('p', { class: 'social-section-note', text: state?.date ? `${state.date} · ${open.length} 项待办` : '读取今日待办' })),
        control('check', { class: 'btn btn-ghost btn-sm', text: '检查更新', onclick: refresh }),
        control('reshuffle:all', { class: 'btn btn-ghost btn-sm daily-reshuffle-all',
          text: pending.has('reshuffle:all') ? '正在换…' : '换一批', title: '重新生成今天的全部建议',
          disabled: reshuffleBusy() || !contacts.length, onclick: () => runReshuffle() })),
      globalNotice ? el('p', { class: 'daily-notice', role: 'status', text: globalNotice }) : null,
      error ? el('p', { class: 'daily-error', role: 'alert', text: error }) : null,
      state ? el('div', { class: 'daily-actions-list', 'aria-label': '今日待办列表' }, ...open.map(({ contact, action }) => actionView(contact, action)), ...statusRows,
        !contacts.length ? el('p', { class: 'daily-list-status', text: '导入聊天后，这里会显示今日行动。' }) : null,
        contacts.length && !open.length && !statusRows.length ? el('p', { class: 'daily-list-status', text: '今天没有待办。' }) : null,
        !open.length && processed.length ? el('p', { class: 'daily-list-status', text: '今日行动已处理完。' }) : null)
        : el('div', { class: 'daily-loading', role: 'status', text: error ? '今日行动暂时不可用，点击“检查更新”重试。' : '正在读取今日行动…' }),
      processed.length ? disclosure('processed', `已处理 ${processed.length} 项`, ...processed.map(({ contact, action }) => actionView(contact, action, true))) : null,
      plans.size ? el('div', { class: 'daily-plans', 'aria-label': '详细计划' }, ...[...plans.values()].map(entry => planView(entry))) : null,
      options.length ? disclosure('options', '推荐设置与依据', ...options.map(contactOptions)) : null
    ].filter(node => node != null));
    if (focusKey) {
      const next = Array.from(element.querySelectorAll?.('[data-daily-control]') || []).find(node => node.getAttribute('data-daily-control') === focusKey);
      next?.focus({ preventScroll: true });
      if (selection) next?.setSelectionRange?.(...selection);
    }
  }

  const onVisibility = () => { if (visible && document.visibilityState !== 'hidden') refresh(); else clearTimeout(timer); };
  render();
  return {
    element,
    show() {
      if (visible) return;
      visible = true;
      document.addEventListener?.('visibilitychange', onVisibility);
      refresh();
    },
    hide() {
      visible = false;
      ++revision;
      // 离开页面时丢掉还没下结论的换一批比对，避免下次进来误报
      reshuffleCheck = null;
      clearTimeout(timer);
      document.removeEventListener?.('visibilitychange', onVisibility);
    }
  };
}
