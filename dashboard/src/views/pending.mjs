import { api } from '../api.mjs';
import { el, empty, fmtTime } from '../ui.mjs';

const TYPE_MAP = { todo: '📌 待办', task: '📌 待办', deadline: '📌 待办', schedule: '📅 日程', reminder: '🔔 提醒', waiting_reply: '📌 待办' };
const STATUS_MAP = { pending_confirm: '🔍 待确认', confirmed: '👍 已处理', ignored: '🚫 已忽略' };
const PAGE_SIZE = 8;

// 待确认意图：AI 只负责“看懂聊天”，不自动创建任务；用户确认后才转为正式任务。
export function mount(container) {
  empty(container);
  container.className = 'view';
  let filter = 'pending_confirm';
  let page = 1;
  let modal = null;

  const list = el('div');
  const pager = el('div', { class: 'list-pager' });
  const chips = el('div', { class: 'chips' });
  for (const [val, label] of [['pending_confirm', '待确认'], ['confirmed', '已确认'], ['', '全部']]) {
    const chip = el('button', { class: 'chip' + (val === filter ? ' active' : ''), text: label });
    chip.onclick = () => {
      filter = val;
      page = 1;
      chips.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
      chip.classList.add('active');
      load();
    };
    chips.append(chip);
  }

  container.append(
    el('div', { class: 'card' },
      el('h2', { text: '待确认意图' }),
      el('div', { class: 'desc', text: '意图识别只负责从聊天中“看懂事项”。确认后，待办进入正式列表，提醒进入提醒系统，日程进入日历。' }),
      chips,
      list,
      pager
    )
  );

  async function load() {
    let items = [];
    try { items = await api.intents.list(filter); } catch {}
    const shown = items.filter((it) => it.status !== 'ignored');
    empty(list);
    if (!shown.length) {
      list.append(el('div', { class: 'empty', text: '没有待确认的行动 🎉' }));
      empty(pager);
      return;
    }
    const totalPages = Math.ceil(shown.length / PAGE_SIZE);
    page = Math.min(page, totalPages);
    const start = (page - 1) * PAGE_SIZE;
    for (const it of shown.slice(start, start + PAGE_SIZE)) {
      const conf = Math.round((it.confidence || 0) * 100);
      const actions = el('div', { class: 'actions' });
      if (it.status === 'pending_confirm') {
        actions.append(el('button', { class: 'btn btn-confirm btn-sm', text: confirmLabel(it), onclick: () => confirmIntent(it) }));
      }
      actions.append(el('button', { class: 'btn btn-danger btn-sm', text: '👎 忽略', onclick: () => update(it.id, { status: 'ignored' }) }));
      if (it.status === 'pending_confirm') {
        actions.append(el('button', { class: 'btn btn-edit btn-sm', text: '修改', onclick: () => edit(it) }));
      }

      list.append(
        el('div', { class: 'item-card' },
          el('div', {},
            el('span', { class: 'badge info', text: TYPE_MAP[it.type] || it.type }),
            ' ' + it.summary,
            el('span', { class: 'muted', text: '（' + (STATUS_MAP[it.status] || it.status) + ' · ' + conf + '%）' })
          ),
          it.detail ? el('div', { class: 'meta', text: it.detail }) : null,
      it.action && it.action.instruction ? el('div', { class: 'meta', text: '🤖 可由 AI 处理：' + it.action.instruction }) : null,
          it.dueText ? el('div', { class: 'meta', text: '⏳ ' + it.dueText + (it.dueAt ? ' → ' + fmtTime(it.dueAt) : '') }) : null,
          el('div', { class: 'meta', text: '来自 ' + ((it.source && it.source.contact) || '未知') + ' · ' + fmtTime(it.createdAt) + (it.reason ? ' · 理由：' + it.reason : '') }),
          actions
        )
      );
    }
    renderPager(totalPages, shown.length);
  }

  function renderPager(totalPages, total) {
    empty(pager);
    if (total <= PAGE_SIZE) return;
    const prev = el('button', { class: 'btn btn-ghost btn-sm', text: '‹', disabled: page === 1 });
    const next = el('button', { class: 'btn btn-ghost btn-sm', text: '›', disabled: page === totalPages });
    prev.onclick = () => { page--; load(); };
    next.onclick = () => { page++; load(); };
    pager.append(prev, el('span', { class: 'list-pager-label', text: `${page} / ${totalPages} · 共 ${total} 项` }), next);
  }

  async function update(id, patch) {
    try {
      await api.intents.update(id, patch);
      window.dispatchEvent(new CustomEvent('intents:changed'));
    } catch (e) {
      alert('保存意图失败：' + ((e && e.message) || e));
    }
    load();
  }

  async function confirmIntent(it) {
    try {
      const result = await api.intents.confirm(it.id);
      window.dispatchEvent(new CustomEvent('intents:changed'));
      window.dispatchEvent(new CustomEvent(result.targetType === 'schedule' ? 'calendar:changed' : 'tasks:changed'));
      load();
    } catch (e) {
      alert('确认失败：' + ((e && e.message) || e));
    }
  }

  async function edit(it) {
    closeModal();
    const summary = el('input', { class: 'input', value: it.summary || '', placeholder: '一句话概括要做什么' });
    const detail = el('textarea', { class: 'input', placeholder: '背景、要求或执行细节（可选）' });
    detail.value = it.detail || '';
    const type = el('select', { class: 'select' },
      el('option', { value: 'todo', text: '待办事项' }),
      el('option', { value: 'reminder', text: '提醒' }),
      el('option', { value: 'schedule', text: '日程' })
    );
    type.value = ['todo', 'reminder', 'schedule'].includes(it.type) ? it.type : 'todo';
    const dueAt = el('input', { class: 'input', type: 'datetime-local' });
    if (it.dueAt) dueAt.value = localDateTime(it.dueAt);
    const dueText = el('input', { class: 'input', value: it.dueText || '', placeholder: '例如：下周五下午三点' });
    const endAt = el('input', { class: 'input', type: 'datetime-local' });
    if (it.endAt) endAt.value = localDateTime(it.endAt);
    const msg = el('span', { class: 'muted' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: '保存修改' });
    const cancelBtn = el('button', { class: 'btn btn-ghost', text: '取消' });
    const field = (label, input) => el('div', { class: 'field' }, el('label', { text: label }), input);

    async function save() {
      const summaryValue = summary.value.trim();
      if (!summaryValue) {
        msg.textContent = '标题不能为空';
        return;
      }
      const patch = {
        summary: summaryValue,
        detail: detail.value.trim(),
        type: type.value,
        dueAt: dueAt.value ? new Date(dueAt.value).toISOString() : null,
        dueText: dueText.value.trim(),
        endAt: endAt.value ? new Date(endAt.value).toISOString() : null
      };
      try {
        await api.intents.update(it.id, patch);
        closeModal();
        window.dispatchEvent(new CustomEvent('intents:changed'));
        load();
      } catch (e) {
        msg.textContent = '保存失败：' + ((e && e.message) || e);
      }
    }

    const mask = el('div', { class: 'modal-mask' });
    mask.append(el('div', { class: 'modal' },
      el('h3', { text: '修改待确认意图' }),
      el('div', { class: 'hint', text: '先修改识别结果，再决定加入待办、创建提醒或加入日历；待办中的 AI 处理需要之后手动启动。' }),
      field('标题 *', summary),
      field('详情', detail),
      field('条目类型', type),
      field('具体时间', dueAt),
      field('日程结束时间（仅日程）', endAt),
      field('原始时间表达', dueText),
      el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:14px;' }, cancelBtn, saveBtn, ' ', msg)
    ));
    saveBtn.onclick = save;
    cancelBtn.onclick = closeModal;
    mask.onclick = (e) => { if (e.target === mask) closeModal(); };
    document.body.append(mask);
    modal = mask;
  }

  function localDateTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function closeModal() {
    if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
    modal = null;
  }

  function confirmLabel(item) {
    if (item.type === 'schedule') return '📅 加入日程';
    if (item.type === 'reminder') return '🔔 创建提醒';
    return '📌 加入待办';
  }

  return { show: load, hide: closeModal };
}
