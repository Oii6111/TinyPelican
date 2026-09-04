import { api } from '../api.mjs';
import { el, empty, fmtTime } from '../ui.mjs';

const KIND_MAP = { once: '一次性', cron: '周期任务' };

export function mount(container) {
  empty(container);
  container.className = 'view';
  let editingId = null;
  let modal = null;

  // ---------- 新建按钮 ----------
  const newBtn = el('button', { class: 'btn btn-primary', text: '＋ 新建任务' });
  container.append(
    el('div', { class: 'board-head' },
      el('div', {},
        el('h2', { text: '任务看板' }),
        el('div', { class: 'desc', text: '一次性任务按截止时间提醒；周期任务使用 cron 表达式定时重复。' })
      ),
      newBtn
    ),
    el('div', { class: 'task-board' },
      el('div', { class: 'board-column', id: 'col-once' },
        el('div', { class: 'board-title', text: '📌 一次性任务' }),
        el('div', { class: 'board-list', id: 'list-once' })
      ),
      el('div', { class: 'board-column', id: 'col-cron' },
        el('div', { class: 'board-title', text: '🔄 周期任务' }),
        el('div', { class: 'board-list', id: 'list-cron' })
      ),
      el('div', { class: 'board-column', id: 'col-done' },
        el('div', { class: 'board-title', text: '✅ 已完成' }),
        el('div', { class: 'board-list', id: 'list-done' })
      )
    )
  );

  // ---------- 弹窗表单 ----------
  function buildModal(task) {
    editingId = task ? task.id : null;

    const title = el('input', { class: 'input', placeholder: '任务标题，如：给张三发周报' });
    const detail = el('textarea', { class: 'input', placeholder: '详情/备注（可选）' });
    const kind = el('select', { class: 'select' },
      el('option', { value: 'once', text: '一次性任务' }),
      el('option', { value: 'cron', text: '周期性定时任务' })
    );
    const dueAt = el('input', { class: 'input', type: 'datetime-local' });
    const cron = el('input', { class: 'input', placeholder: '0 9 * * *' });
    const msg = el('span', { class: 'muted' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: editingId ? '保存修改' : '创建任务' });
    const cancelBtn = el('button', { class: 'btn btn-ghost', text: '取消' });

    function syncKindUI() {
      const isCron = kind.value === 'cron';
      dueAt.closest('.field').style.display = isCron ? 'none' : '';
      cron.closest('.field').style.display = isCron ? '' : 'none';
    }
    kind.onchange = syncKindUI;

    if (task) {
      title.value = task.title || '';
      detail.value = task.detail || '';
      kind.value = task.kind === 'cron' ? 'cron' : 'once';
      cron.value = task.cron || '';
      if (task.dueAt) {
        const d = new Date(task.dueAt);
        const pad = (n) => String(n).padStart(2, '0');
        dueAt.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }
    }

    function field(labelText, input) {
      return el('div', { class: 'field' }, el('label', { text: labelText }), input);
    }

    async function save() {
      const patch = {
        title: title.value.trim(),
        detail: detail.value.trim(),
        kind: kind.value,
        dueAt: kind.value === 'once' && dueAt.value ? new Date(dueAt.value).toISOString() : null,
        cron: kind.value === 'cron' ? cron.value.trim() : ''
      };
      if (!patch.title) {
        msg.textContent = '任务标题不能为空';
        return;
      }
      try {
        if (editingId) await api.tasks.update(editingId, patch);
        else await api.tasks.create(patch);
        close();
        load();
      } catch (e) {
        msg.textContent = '保存失败：' + e.message;
      }
    }

    const mask = el('div', { class: 'modal-mask' });
    mask.append(
      el('div', { class: 'modal' },
        el('h3', { text: editingId ? '编辑任务' : '新建任务' }),
        field('标题 *', title),
        field('详情', detail),
        field('类型', kind),
        field('到期时间（一次性）', dueAt),
        field('Cron 表达式（周期任务）', cron),
        el('div', { class: 'hint', text: '5 段：分 时 日 月 星期。示例：0 9 * * * = 每天 09:00。' }),
        el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:14px;' }, cancelBtn, saveBtn, ' ', msg)
      )
    );

    saveBtn.onclick = save;
    cancelBtn.onclick = close;
    newBtn.onclick = close;
    mask.onclick = (e) => { if (e.target === mask) close(); };

    syncKindUI();
    document.body.append(mask);
    modal = mask;
  }

  function close() {
    if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
    modal = null;
    editingId = null;
  }

  // ---------- 卡片 ----------
  function timeText(t) {
    if (t.kind === 'cron') {
      const next = t.nextAt ? '下次 ' + fmtTime(t.nextAt) : '待计算';
      return next + (t.cron ? ' · ' + t.cron : '');
    }
    return t.dueAt ? '截止 ' + fmtTime(t.dueAt) : '无到期时间';
  }

  function card(t) {
    const actions = el('div', { class: 'task-actions' });
    if (t.status === 'open') {
      actions.append(el('button', { class: 'btn btn-confirm btn-sm', text: t.kind === 'cron' ? '✔ 完成本期' : '✔ 完成', onclick: () => complete(t) }));
    } else {
      actions.append(el('button', { class: 'btn btn-ghost btn-sm', text: '↩ 重开', onclick: () => reopen(t) }));
    }
    actions.append(el('button', { class: 'btn btn-edit btn-sm', text: '编辑', onclick: () => buildModal(t) }));
    actions.append(el('button', { class: 'btn btn-danger btn-sm', text: '删除', onclick: () => remove(t) }));

    return el('div', { class: 'task-card' },
      el('div', { class: 'task-title', text: t.title }),
      t.detail ? el('div', { class: 'meta', text: t.detail }) : null,
      el('div', { class: 'meta', text: timeText(t) }),
      t.sourceIntentId ? el('div', { class: 'meta muted', text: '来源意图' }) : null,
      actions
    );
  }

  async function load() {
    let items = [];
    try { items = await api.tasks.list(); } catch {}
    const groups = { once: [], cron: [], done: [] };
    for (const t of items) {
      if (t.status === 'done') groups.done.push(t);
      else if (t.kind === 'cron') groups.cron.push(t);
      else groups.once.push(t);
    }
    for (const [key, elId] of [['once', 'list-once'], ['cron', 'list-cron'], ['done', 'list-done']]) {
      const box = container.querySelector('#' + elId);
      empty(box);
      if (!groups[key].length) {
        box.append(el('div', { class: 'board-empty', text: key === 'done' ? '暂无已完成任务' : '暂无任务' }));
        continue;
      }
      for (const t of groups[key]) box.append(card(t));
    }
  }

  async function complete(t) {
    try { await api.tasks.complete(t.id); load(); } catch {}
  }

  async function reopen(t) {
    try { await api.tasks.update(t.id, { status: 'open' }); load(); } catch {}
  }

  async function remove(t) {
    if (!confirm('确定删除任务「' + t.title + '」？')) return;
    try {
      await api.tasks.remove(t.id);
      if (modal && editingId === t.id) close();
      load();
    } catch {}
  }

  newBtn.onclick = () => buildModal(null);

  return { show: load, hide() { close(); } };
}
