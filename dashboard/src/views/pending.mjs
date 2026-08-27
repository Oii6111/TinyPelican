import { api } from '../api.mjs';
import { el, empty, fmtTime } from '../ui.mjs';

const TYPE_MAP = { task: '📌 任务', deadline: '⏰ DDL', schedule: '📅 日程', reminder: '🔔 事项提醒', waiting_reply: '💬 等待回复' };
const STATUS_MAP = { auto_added: '✅ 已添加', pending_confirm: '🔍 待确认', confirmed: '👍 已确认', ignored: '🚫 已忽略' };

// 待确认行动：AI 主动生成、尚未自动执行、需要用户确认的动作
export function mount(container) {
  empty(container);
  container.className = 'view';
  let filter = 'pending_confirm';

  const list = el('div');
  const chips = el('div', { class: 'chips' });
  for (const [val, label] of [['pending_confirm', '待确认'], ['auto_added', '已自动添加'], ['', '全部']]) {
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
    el('div', { class: 'card' },
      el('h2', { text: '待确认行动' }),
      el('div', { class: 'desc', text: 'AI 主动生成、尚未自动执行、需要你确认的行动。确认后进入正式事项并按策略触发提醒；忽略会记入学习反馈。' }),
      chips,
      list
    )
  );

  async function load() {
    let items = [];
    try { items = await api.intents.list(filter); } catch {}
    const shown = items.filter((it) => it.status !== 'ignored');
    empty(list);
    if (!shown.length) {
      list.append(el('div', { class: 'empty', text: '没有待确认的行动 🎉' }));
      return;
    }
    for (const it of shown) {
      const conf = Math.round((it.confidence || 0) * 100);
      const actions = el('div', { class: 'actions' });
      if (it.status === 'pending_confirm') {
        actions.append(el('button', { class: 'btn btn-confirm btn-sm', text: '👍 确认执行', onclick: () => update(it.id, { status: 'confirmed' }) }));
      }
      actions.append(el('button', { class: 'btn btn-danger btn-sm', text: '👎 忽略', onclick: () => update(it.id, { status: 'ignored' }) }));
      actions.append(el('button', { class: 'btn btn-edit btn-sm', text: '修改', onclick: () => edit(it) }));

      list.append(
        el('div', { class: 'item-card' },
          el('div', {},
            el('span', { class: 'badge info', text: TYPE_MAP[it.type] || it.type }),
            ' ' + it.summary,
            el('span', { class: 'muted', text: '（' + (STATUS_MAP[it.status] || it.status) + ' · ' + conf + '%）' })
          ),
          it.detail ? el('div', { class: 'meta', text: it.detail }) : null,
          it.dueText ? el('div', { class: 'meta', text: '⏳ ' + it.dueText + (it.dueAt ? ' → ' + fmtTime(it.dueAt) : '') }) : null,
          el('div', { class: 'meta', text: '来自 ' + ((it.source && it.source.contact) || '未知') + ' · ' + fmtTime(it.createdAt) + (it.reason ? ' · 理由：' + it.reason : '') }),
          actions
        )
      );
    }
  }

  async function update(id, patch) {
    try { await api.intents.update(id, patch); } catch {}
    load();
  }

  async function edit(it) {
    const summary = prompt('修改行动标题：', it.summary || '');
    if (summary === null) return;
    const dueText = prompt('修改时间表达（没有可留空）：', it.dueText || '') || '';
    await update(it.id, { summary, dueText });
  }

  return { show: load, hide() {} };
}
