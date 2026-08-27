import { api } from '../api.mjs';
import { el, empty, fmtTime } from '../ui.mjs';

export function mount(container, ctx) {
  empty(container);
  container.className = 'view';
  const hbCard = el('div');
  const stats = el('div', { class: 'stat-grid' });
  const recent = el('div');
  container.append(
    hbCard,
    el('div', { class: 'card' },
      el('h2', { text: '今日主动行为' }),
      el('div', { class: 'desc', text: 'Agent 识别与采纳情况的统计。' }),
      stats
    ),
    el('div', { class: 'card' },
      el('h2', {},
        el('span', { text: '最近动作' }),
        ' ',
        el('button', { class: 'btn btn-ghost btn-sm', text: '查看全部 →', onclick: () => ctx.navigate('records') })
      ),
      recent
    )
  );

  async function load() {
    let st = null;
    try { st = await api.status(); } catch {}
    const on = !!(st && st.heartbeat && st.heartbeat.online);
    empty(hbCard);
    hbCard.append(
      el('div', { class: 'card' },
        el('h2', {}, el('span', { class: 'hb-dot' + (on ? ' on' : '') }), ' Agent 心跳'),
        el('div', { class: 'desc', text: on ? '在线 · 每 ' + (st.heartbeat.intervalSec || 30) + ' 秒扫描一次环境' : '离线（核心未运行，仅看板展示）' }),
        el('div', { class: 'row' },
          el('div', { class: 'stat-mini' },
            el('div', { class: 'stat-label', text: '最后心跳' }),
            el('div', { class: 'stat-val', style: 'font-size:16px;', text: st && st.heartbeat.lastBeatAt ? fmtTime(st.heartbeat.lastBeatAt) : '--' })
          ),
          el('div', { class: 'stat-mini' },
            el('div', { class: 'stat-label', text: '下次心跳' }),
            el('div', { class: 'stat-val', style: 'font-size:16px;', text: st && st.heartbeat.nextBeatAt ? fmtTime(st.heartbeat.nextBeatAt) : '--' })
          ),
          el('div', { class: 'stat-mini' },
            el('div', { class: 'stat-label', text: '主动级别' }),
            el('div', { class: 'stat-val', style: 'font-size:16px;', text: (st && st.proactivity && st.proactivity.level) || 'L2' })
          )
        )
      )
    );

    let intents = [];
    try { intents = await api.intents.list(); } catch {}
    const counts = { total: intents.length, pending: 0, confirmed: 0, ignored: 0 };
    for (const it of intents) {
      if (it.status === 'pending_confirm') counts.pending++;
      else if (it.status === 'confirmed') counts.confirmed++;
      else if (it.status === 'ignored') counts.ignored++;
    }
    const rate = counts.total ? Math.round((counts.confirmed / counts.total) * 100) : 0;
    empty(stats);
    for (const [label, val] of [['识别事项', counts.total], ['待确认', counts.pending], ['已采纳', counts.confirmed], ['采纳率', rate + '%']]) {
      stats.append(
        el('div', { class: 'stat-card' },
          el('div', { class: 'stat-val', text: String(val) }),
          el('div', { class: 'stat-label', text: label })
        )
      );
    }

    let logs = [];
    try { logs = await api.logs.list(200); } catch {}
    const acts = logs.filter((l) => ['remind', 'relation', 'weixin', 'intent'].includes(l.source)).slice(0, 8);
    empty(recent);
    if (!acts.length) {
      recent.append(el('div', { class: 'empty', text: '暂无动作' }));
      return;
    }
    for (const l of acts) {
      recent.append(
        el('div', { class: 'item-card' },
          el('div', {},
            el('span', { class: 'badge ' + (l.level === 'error' ? 'error' : 'info'), text: l.source }),
            ' ' + (l.message || '')
          ),
          el('div', { class: 'meta', text: fmtTime(l.ts) })
        )
      );
    }
  }

  return { show: load, hide() {} };
}
