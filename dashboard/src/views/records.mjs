import { api } from '../api.mjs';
import { el, empty, fmtTime } from '../ui.mjs';

const TYPE_MAP = { todo: '📌 待办', task: '📌 待办', deadline: '📌 待办', schedule: '📅 日程', reminder: '🔔 提醒', waiting_reply: '📌 待办' };
const STATUS_MAP = { auto_added: '✅ 已添加', pending_confirm: '🔍 待确认', confirmed: '👍 已确认', ignored: '🚫 已忽略' };
const PAGE_SIZE = 20;

// 思考和行动记录：行动轨迹 + 思考日志 合并为一个时间线
export function mount(container) {
  empty(container);
  container.className = 'view';
  let filter = 'all';
  let kw = '';
  let page = 1;

  const list = el('div');
  const pager = el('div', { class: 'list-pager' });
  const chips = el('div', { class: 'chips' });
  const search = el('input', { class: 'input', placeholder: '搜索记录…' });

  for (const [val, label] of [['all', '全部'], ['action', '行动'], ['think', '思考']]) {
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
      el('h2', { text: '思考和行动记录' }),
      el('div', { class: 'desc', text: 'Agent 的思考过程与已采取的行动，按时间倒序合并展示；「行动」是需要你确认或已执行的动作，「思考」是后台观察与决策过程。' }),
      el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px;' },
        chips,
        el('div', { style: 'flex:1;min-width:180px;' }, search)
      ),
      list,
      pager
    )
  );

  async function load() {
    let intents = [];
    let logs = [];
    let agentTasks = [];
    try { intents = await api.intents.list(); } catch {}
    try { logs = await api.logs.list(500); } catch {}
    try { agentTasks = await api.agent.list(200); } catch {}

    const entries = [];
    for (const it of intents) {
      entries.push({ kind: 'action', sub: 'intent', ts: it.createdAt || it.updatedAt || '', it });
    }
    for (const l of logs) {
      const isAction = l.source === 'remind' || l.source === 'relation' || (l.source === 'weixin' && /推送/.test(l.message || ''));
      entries.push({ kind: isAction ? 'action' : 'think', sub: l.source, ts: l.ts, level: l.level, label: l.message || '' });
    }
    for (const task of agentTasks) {
      entries.push({
        kind: 'action',
        sub: 'DSH',
        ts: task.finishedAt || task.startedAt || task.createdAt,
        level: task.status === 'failed' ? 'error' : 'info',
        label: `直接执行：${task.task || ''} · ${agentStatus(task.status)}`
      });
    }
    entries.sort((a, b) => (String(b.ts) < String(a.ts) ? -1 : String(b.ts) > String(a.ts) ? 1 : 0));

    const kwl = kw.toLowerCase();
    const shown = entries.filter((e) => {
      if (filter !== 'all' && e.kind !== filter) return false;
      if (!kwl) return true;
      const text = e.it
        ? (e.it.summary + ' ' + ((e.it.source && e.it.source.contact) || ''))
        : (e.label || '');
      return text.toLowerCase().includes(kwl);
    });

    empty(list);
    if (!shown.length) {
      list.append(el('div', { class: 'empty', text: '暂无记录' }));
      empty(pager);
      return;
    }
    const totalPages = Math.ceil(shown.length / PAGE_SIZE);
    page = Math.min(page, totalPages);
    const start = (page - 1) * PAGE_SIZE;
    for (const e of shown.slice(start, start + PAGE_SIZE)) {
      if (e.kind === 'action' && e.it) {
        const it = e.it;
        const conf = Math.round((it.confidence || 0) * 100);
        list.append(
          el('div', { class: 'item-card' },
            el('div', {},
              el('span', { class: 'badge info', text: TYPE_MAP[it.type] || it.type }),
              ' ' + it.summary,
              el('span', { class: 'muted', text: '（' + (STATUS_MAP[it.status] || it.status) + ' · ' + conf + '%）' })
            ),
            el('div', { class: 'meta', text: '行动 · 来自 ' + ((it.source && it.source.contact) || '未知') + ' · ' + fmtTime(e.ts) })
          )
        );
      } else {
        list.append(
          el('div', { class: 'item-card' },
            el('div', {},
              el('span', { class: 'badge ' + (e.level === 'error' ? 'error' : 'warn'), text: e.sub }),
              ' ' + (e.label || '')
            ),
            el('div', { class: 'meta', text: (e.kind === 'think' ? '思考 · ' : '行动 · ') + fmtTime(e.ts) })
          )
        );
      }
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
    pager.append(prev, el('span', { class: 'list-pager-label', text: `${page} / ${totalPages} · 共 ${total} 条` }), next);
  }

  function agentStatus(status) {
    return { queued: '排队中', running: '进行中', completed: '已完成', failed: '失败' }[status] || status || '未知';
  }

  search.addEventListener('input', () => { kw = search.value.trim(); page = 1; load(); });

  return { show: load, hide() {} };
}
