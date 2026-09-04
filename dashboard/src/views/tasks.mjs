import { api } from '../api.mjs';
import { el, empty, fmtTime } from '../ui.mjs';

const KIND_MAP = { once: '一次性', cron: '周期任务' };
const STATUS_MAP = { open: '待办', done: '已完成' };

export function mount(container) {
  empty(container);
  container.className = 'view';
  let filter = 'open';
  let editingId = null;

  const titleInput = el('input', { class: 'input', placeholder: '任务标题，如：给张三发周报' });
  const detailInput = el('textarea', { class: 'input', placeholder: '详情/备注（可选）' });
  const kindSel = el('select', { class: 'select' },
    el('option', { value: 'once', text: '一次性任务' }),
    el('option', { value: 'cron', text: '周期性定时任务' })
  );
  const dueAtInput = el('input', { class: 'input', type: 'datetime-local' });
  const cronInput = el('input', { class: 'input', placeholder: 'cron 表达式，如：0 9 * * *' });
  const formMsg = el('span', { class: 'muted' });
  const saveBtn = el('button', { class: 'btn btn-primary', text: '保存任务' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '取消' });
  const list = el('div');

  function syncKindUI() {
    const isCron = kindSel.value === 'cron';
    dueAtInput.style.display = isCron ? 'none' : '';
    cronInput.style.display = isCron ? '' : 'none';
  }
  kindSel.onchange = syncKindUI;

  function resetForm() {
    editingId = null;
    titleInput.value = '';
    detailInput.value = '';
    kindSel.value = 'once';
    dueAtInput.value = '';
    cronInput.value = '';
    syncKindUI();
    formMsg.textContent = '';
    saveBtn.textContent = '保存任务';
  }

  function field(label, inputEl, hint = '') {
    return el('div', { class: 'field' },
      el('label', { text: label }),
      inputEl,
      hint ? el('div', { class: 'hint', text: hint }) : null
    );
  }

  const formCard = el('div', { class: 'card' },
    el('h2', { id: 'task-form-title', text: '新建任务' }),
    field('标题 *', titleInput),
    field('详情', detailInput),
    field('类型', kindSel),
    field('到期时间（一次性）', dueAtInput),
    field('Cron 表达式（周期任务）', cronInput, '5 段：分 时 日 月 星期。示例：0 9 * * * 表示每天 09:00。'),
    el('div', { class: 'row' }, saveBtn, cancelBtn, ' ', formMsg)
  );

  const chips = el('div', { class: 'chips' });
  for (const [val, label] of [['open', '待办'], ['done', '已完成'], ['', '全部']]) {
    const chip = el('button', { class: 'chip' + (val === filter ? ' active' : ''), text: label });
    chip.onclick = () => {
      filter = val;
      chips.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
      chip.classList.add('active');
      load();
    };
    chips.append(chip);
  }

  container.append(
    formCard,
    el('div', { class: 'card' },
      el('h2', {}, el('span', { text: '任务列表' }), ' ', el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 新建', onclick: resetForm })),
      chips,
      list
    )
  );

  function taskPatch() {
    return {
      title: titleInput.value.trim(),
      detail: detailInput.value.trim(),
      kind: kindSel.value,
      dueAt: kindSel.value === 'once' && dueAtInput.value
        ? new Date(dueAtInput.value).toISOString()
        : null,
      cron: kindSel.value === 'cron' ? cronInput.value.trim() : ''
    };
  }

  async function save() {
    const patch = taskPatch();
    if (!patch.title) {
      formMsg.textContent = '任务标题不能为空';
      return;
    }
    try {
      if (editingId) {
        await api.tasks.update(editingId, patch);
        formMsg.textContent = '已更新 ✓';
      } else {
        await api.tasks.create(patch);
        formMsg.textContent = '已创建 ✓';
      }
      resetForm();
      load();
    } catch (e) {
      formMsg.textContent = '保存失败：' + e.message;
    }
    setTimeout(() => { formMsg.textContent = ''; }, 2500);
  }

  function edit(task) {
    editingId = task.id;
    titleInput.value = task.title || '';
    detailInput.value = task.detail || '';
    kindSel.value = task.kind === 'cron' ? 'cron' : 'once';
    if (task.dueAt) {
      const d = new Date(task.dueAt);
      const pad = (n) => String(n).padStart(2, '0');
      dueAtInput.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } else {
      dueAtInput.value = '';
    }
    cronInput.value = task.cron || '';
    syncKindUI();
    container.querySelector('#task-form-title').textContent = '编辑任务';
    saveBtn.textContent = '保存修改';
    formCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function complete(task) {
    try {
      await api.tasks.complete(task.id);
      load();
    } catch {}
  }

  async function reopen(task) {
    try {
      await api.tasks.update(task.id, { status: 'open' });
      load();
    } catch {}
  }

  async function remove(task) {
    if (!confirm('确定删除任务「' + task.title + '」？')) return;
    try {
      await api.tasks.remove(task.id);
      if (editingId === task.id) resetForm();
      load();
    } catch {}
  }

  async function load() {
    let items = [];
    try { items = await api.tasks.list(filter); } catch {}
    empty(list);
    if (!items.length) {
      list.append(el('div', { class: 'empty', text: filter === 'done' ? '还没有已完成任务' : '还没有任务，点上方“新建”创建一个吧' }));
      return;
    }
    for (const t of items) {
      const timeText = t.kind === 'cron'
        ? '🔄 ' + (t.nextAt ? '下次 ' + fmtTime(t.nextAt) : '待计算') + ' · ' + (t.cron || '')
        : (t.dueAt ? '⏰ ' + fmtTime(t.dueAt) : '无到期时间');
      const actions = el('div', { class: 'actions' });
      if (t.status === 'open') {
        actions.append(el('button', { class: 'btn btn-confirm btn-sm', text: t.kind === 'cron' ? '✔ 完成本期' : '✔ 完成', onclick: () => complete(t) }));
      } else {
        actions.append(el('button', { class: 'btn btn-ghost btn-sm', text: '↩ 重新打开', onclick: () => reopen(t) }));
      }
      actions.append(el('button', { class: 'btn btn-edit btn-sm', text: '编辑', onclick: () => edit(t) }));
      actions.append(el('button', { class: 'btn btn-danger btn-sm', text: '删除', onclick: () => remove(t) }));

      list.append(
        el('div', { class: 'item-card' },
          el('div', {},
            el('span', { class: 'badge ' + (t.kind === 'cron' ? 'info' : 'warn'), text: KIND_MAP[t.kind] || t.kind }),
            ' ' + t.title,
            el('span', { class: 'muted', text: '（' + (STATUS_MAP[t.status] || t.status) + '）' })
          ),
          t.detail ? el('div', { class: 'meta', text: t.detail }) : null,
          el('div', { class: 'meta', text: timeText }),
          t.sourceIntentId ? el('div', { class: 'meta', text: '来自意图：' + t.sourceIntentId }) : null,
          actions
        )
      );
    }
  }

  saveBtn.onclick = save;
  cancelBtn.onclick = resetForm;

  return { show: load, hide() {} };
}
