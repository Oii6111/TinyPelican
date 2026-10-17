import { api } from '../api.mjs';
import { el, empty, fmtTime, toast } from '../ui.mjs';

function senderOf(message) {
  const value = message.from || message.sender || message.fromAddress || '未知发件人';
  return typeof value === 'object' ? (value.name || value.address || '未知发件人') : value;
}

export function mountInbox(container, ctx) {
  container.className = `view${container.className ? ' ' + container.className : ''}`;
  const status = el('span', { class: 'badge warn', text: '读取状态中' });
  const list = el('div');
  const important = el('input', { type: 'checkbox' });
  const loadButton = el('button', { class: 'btn btn-ghost btn-sm', text: '刷新' });
  const syncButton = el('button', { class: 'btn btn-ghost btn-sm', text: '立即同步' });
  const testButton = el('button', { class: 'btn btn-ghost btn-sm', text: '测试连接' });
  loadButton.onclick = load; syncButton.onclick = sync; testButton.onclick = test; important.onchange = load;
  container.append(el('div', { class: 'card' },
    el('div', { class: 'row', style: 'align-items:center;justify-content:space-between;' },
      el('div', {}, el('h2', { text: '收件箱' }), el('div', { class: 'desc', text: '未知分类会交给 Agent 再读一遍。' })), status),
    el('div', { class: 'actions' }, loadButton, syncButton, testButton,
      el('label', { class: 'inline-check' }, important, el('span', { text: '只看重要邮件' })),
      el('button', { class: 'btn btn-primary btn-sm', text: '新邮件', onclick: () => ctx.navigate('email-compose') })), list));

  async function load() {
    status.textContent = '加载中'; status.className = 'badge warn'; empty(list);
    try {
      const result = await api.email.messages({ limit: 50, ...(important.checked ? { important: true } : {}) });
      const messages = Array.isArray(result) ? result : (result?.messages || result?.items || []);
      if (!messages.length) { status.textContent = important.checked ? '暂无重要邮件' : '暂无邮件'; list.append(el('div', { class: 'empty', text: '还没有符合条件的邮件。' })); return; }
      status.textContent = `${messages.length} 封邮件`; status.className = 'badge info';
      for (const message of messages) {
        const category = String(message.category || message.analysis?.category || 'unknown');
        const categoryClass = category === 'important' ? 'info' : (category === 'ads' || category === 'noise' ? 'muted' : 'warn');
        const body = message.text || message.body || message.snippet || message.summary || '';
        list.append(el('details', { class: 'item-card email-memory-item' },
          el('summary', {}, el('strong', { text: message.subject || '无主题' }), el('span', { class: 'muted', text: `  ${senderOf(message)}  ${fmtTime(message.date || message.receivedAt || message.ts)}` }), el('span', { class: `badge ${categoryClass}`, text: category })),
          message.summary ? el('div', { class: 'meta', text: message.summary }) : null, el('div', { class: 'email-memory-body', text: body }),
          message.contact ? el('div', { class: 'meta', text: `联系人：${message.contact}` }) : null,
          message.attachments?.length ? el('div', { class: 'meta', text: `附件：${message.attachments.map((x) => x.filename || x.name || x).join(', ')}` }) : null));
      }
    } catch (error) { status.textContent = '加载失败'; list.append(el('div', { class: 'empty', text: `邮件加载失败：${error.message}` })); }
  }
  async function sync() { syncButton.disabled = true; try { await api.email.sync(); await load(); toast('邮件同步已开始'); } catch (error) { toast(`同步失败：${error.message}`, false); } finally { syncButton.disabled = false; } }
  async function test() { testButton.disabled = true; try { const result = await api.email.test(); if (result?.ok === false || result?.imap?.ok === false || result?.smtp?.ok === false) throw new Error(result.error || result.message || '连接失败'); toast('邮件连接测试成功'); } catch (error) { toast(`连接测试失败：${error.message}`, false); } finally { testButton.disabled = false; } }
  return { show: load, hide() {} };
}

export function mountCompose(container, ctx) {
  container.className = `view${container.className ? ' ' + container.className : ''}`;
  const status = el('span', { class: 'muted', role: 'status' });
  const to = el('input', { class: 'input', type: 'email', placeholder: '收件人 *' });
  const cc = el('input', { class: 'input', type: 'text', placeholder: '抄送，可选' });
  const subject = el('input', { class: 'input', placeholder: '主题 *' });
  const text = el('textarea', { class: 'input', rows: 10, placeholder: '纯文本正文 *' });
  const html = el('textarea', { class: 'input', rows: 5, placeholder: 'HTML 正文，可选' });
  const send = el('button', { class: 'btn btn-primary btn-sm', text: '发送邮件' });
  container.append(el('div', { class: 'card' }, el('div', { class: 'actions' }, el('button', { class: 'btn btn-ghost btn-sm', text: '返回收件箱', onclick: () => ctx.navigate('email-inbox') })), el('h2', { text: '新邮件' }), el('div', { class: 'desc', text: '只在你点击发送后发出，不会自动回复或群发。' }),
    el('div', { class: 'field' }, el('label', { text: '收件人 *' }), to), el('div', { class: 'field' }, el('label', { text: '抄送' }), cc), el('div', { class: 'field' }, el('label', { text: '主题 *' }), subject), el('div', { class: 'field' }, el('label', { text: '纯文本正文 *' }), text), el('div', { class: 'field' }, el('label', { text: 'HTML 正文（可选）' }), html), el('div', { class: 'field' }, send, ' ', status)));
  send.onclick = async () => {
    if (!to.value.trim() || !subject.value.trim() || (!text.value.trim() && !html.value.trim())) { status.textContent = '请填写收件人、主题和正文。'; return; }
    send.disabled = true; status.textContent = '发送中…';
    try { const result = await api.email.send({ to: to.value.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean), cc: cc.value.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean), subject: subject.value.trim(), text: text.value, html: html.value.trim() }); if (result?.ok === false) throw new Error(result.error || result.message || '发送失败'); status.textContent = '邮件已发送'; to.value = ''; cc.value = ''; subject.value = ''; text.value = ''; html.value = ''; }
    catch (error) { status.textContent = `发送失败：${error.message}`; } finally { send.disabled = false; }
  };
  return { show() {}, hide() {} };
}

export function mount(container, ctx = {}) {
  container.className = 'view email-page';
  empty(container);
  const tabs = el('nav', { class: 'email-tabs', 'aria-label': '邮件页面' });
  const inboxPane = el('section', { class: 'email-pane', 'data-email-pane': 'inbox' });
  const composePane = el('section', { class: 'email-pane', 'data-email-pane': 'compose', hidden: true });
  const wrapper = el('div', { class: 'email-page-content' }, tabs, inboxPane, composePane);
  container.append(wrapper);

  let active = 'inbox';
  let inboxView;
  let composeView;
  const localCtx = {
    ...ctx,
    navigate(id, params) {
      if (id === 'email-inbox') return activate('inbox');
      if (id === 'email-compose') return activate('compose');
      return ctx.navigate?.(id, params);
    }
  };

  function activate(next, { load = true } = {}) {
    active = next === 'compose' ? 'compose' : 'inbox';
    const inboxActive = active === 'inbox';
    inboxPane.hidden = !inboxActive;
    composePane.hidden = inboxActive;
    tabs.querySelectorAll('.email-tab').forEach((tab) => {
      const selected = tab.getAttribute('data-email-tab') === active;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
    });
    if (load) {
      if (inboxActive) inboxView?.show?.();
      else composeView?.show?.();
    }
  }

  for (const [id, label] of [['inbox', '收件箱'], ['compose', '新邮件']]) {
    tabs.append(el('button', {
      class: 'email-tab' + (id === active ? ' active' : ''),
      type: 'button',
      'data-email-tab': id,
      'aria-selected': id === active,
      text: label,
      onclick: () => activate(id)
    }));
  }
  inboxView = mountInbox(inboxPane, localCtx);
  composeView = mountCompose(composePane, localCtx);
  activate('inbox');

  return {
    show(params = {}) { activate(params.tab === 'compose' ? 'compose' : 'inbox'); },
    hide() { inboxView?.hide?.(); composeView?.hide?.(); }
  };
}
