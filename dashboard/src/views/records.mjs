import { api } from '../api.mjs';
import { el, empty, fmtTime } from '../ui.mjs';

const TYPE_MAP = { task: '📌 任务', deadline: '⏰ DDL', schedule: '📅 日程', reminder: '🔔 事项提醒', waiting_reply: '💬 等待回复' };
const STATUS_MAP = { auto_added: '✅ 已添加', pending_confirm: '🔍 待确认', confirmed: '👍 已确认', ignored: '🚫 已忽略' };

// 思考和行动记录：行动轨迹 + 思考日志 合并为一个时间线
export function mount(container) {
  empty(container);
  container.className = 'view';
  let filter = 'all';
  let kw = '';

  const list = el('div');
  const chips = el('div', { class: 'chips' });
  const search = el('input', { class: 'input', placeholder: '搜索记录…' });

  for (const [val, label] of [['all', '全部'], ['action', '行动'], ['think', '思考']]) {
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
      el('h2', { text: '思考和行动记录' }),
      el('div', { class: 'desc', text: 'Agent 的思考过程与已采取的行动，按时间倒序合并展示；「行动」是需要你确认或已执行的动作，「思考」是后台观察与决策过程。' }),
      el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px;' },
        chips,
        el('div', { style: 'flex:1;min-width:180px;' }, search)
      ),
      list
    )
  );

  async function load() {
    let intents = [];
    let logs = [];
    try { intents = await api.intents.list(); } catch {}
    try { logs = await api.logs.list(500); } catch {}

    const entries = [];
    for (const it of intents) {
      entries.push({ kind: 'action', sub: 'intent', ts: it.createdAt || it.updatedAt || '', it });
    }
    for (const l of logs) {
      const isAction = l.source === 'remind' || l.source === 'relation' || (l.source === 'weixin' && /推送/.test(l.message || ''));
      entries.push({ kind: isAction ? 'action' : 'think', sub: l.source, ts: l.ts, level: l.level, label: l.message || '' });
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
      return;
    }
    for (const e of shown) {
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
  }

  search.addEventListener('input', () => { kw = search.value.trim(); load(); });

  return { show: load, hide() {} };
}
