import { api } from '../api.mjs';
import { el, empty } from '../ui.mjs';

const LEVELS = [
  ['L0', 'L0 · 静默准备'],
  ['L1', 'L1 · 提示'],
  ['L2', 'L2 · 建议'],
  ['L3', 'L3 · 确认后执行'],
  ['L4', 'L4 · 自动执行']
];

export function mount(container) {
  empty(container);
  container.className = 'view';
  const levelSel = el('select', { class: 'select' }, ...LEVELS.map(([v, l]) => el('option', { value: v, text: l })));
  const hbSec = el('input', { class: 'input', type: 'number', min: '5', step: '5' });
  const relationChk = el('input', { type: 'checkbox' });
  const relationDays = el('input', { class: 'input', type: 'number', min: '1', max: '365' });
  const dndChk = el('input', { type: 'checkbox' });
  const dndStart = el('input', { type: 'time', class: 'input' });
  const dndEnd = el('input', { type: 'time', class: 'input' });
  const ddlDays = el('input', { class: 'input', placeholder: '如 1,2' });
  const ddlHours = el('input', { class: 'input', placeholder: '如 2' });
  const schedLead = el('input', { class: 'input', type: 'number', min: '0' });
  const saveMsg = el('span', { class: 'muted' });

  function field(label, inputEl, hint = '') {
    return el('div', { class: 'field' },
      el('label', { text: label }),
      inputEl,
      hint ? el('div', { class: 'hint', text: hint }) : null
    );
  }
  function switchField(label, inputEl, hint = '') {
    return el('div', { class: 'field' },
      el('label', { class: 'switch' }, inputEl, ' ' + label),
      hint ? el('div', { class: 'hint', text: hint }) : null
    );
  }

  container.append(
    el('div', { class: 'settings-page' },
      el('div', { class: 'card' },
        el('h2', { text: '主动级别' }),
        el('div', { class: 'desc', text: '全局主动级别决定 Agent 在什么程度上替你做决定：L0 只准备不打扰，L2 给建议，L4 自动执行。' }),
        field('全局主动级别', levelSel),
        field('心跳间隔（秒）', hbSec, '核心每隔该秒数扫描一次环境并更新在线状态。修改后重启核心生效。')
      ),
      el('div', { class: 'card' },
        el('h2', { text: '提醒策略' }),
        field('DDL 提前天数（逗号分隔）', ddlDays, '例如 1,2 表示提前 1 天和 2 天各提醒一次。'),
        field('DDL 提前小时（逗号分隔）', ddlHours),
        field('日程提前分钟', schedLead),
        switchField('启用免打扰', dndChk, '免打扰时段内不推送主动提醒，等结束后再补推。'),
        el('div', { class: 'row' },
          field('免打扰开始', dndStart),
          field('免打扰结束', dndEnd, '支持跨天，例如 23:00 - 08:00。')
        )
      ),
      el('div', { class: 'card' },
        el('h2', { text: '关系维护' }),
        switchField('启用关系维护提醒', relationChk, '对标记 ⭐ 的联系人，超过“冷落天数”没联系时推送问候建议。'),
        field('冷落天数', relationDays, '例如 7 表示 7 天没联系就提醒。'),
        el('div', {}, el('button', { class: 'btn btn-primary', text: '保存策略', onclick: save }), ' ', saveMsg)
      )
    )
  );

  function parseList(v) {
    return String(v || '').split(/[,，]/).map((x) => parseInt(x.trim(), 10)).filter((n) => !isNaN(n) && n >= 0);
  }

  async function load() {
    try {
      const s = await api.settings.get();
      levelSel.value = (s.proactivity && s.proactivity.level) || 'L2';
      hbSec.value = (s.heartbeat && s.heartbeat.intervalSec) || 30;
      relationChk.checked = !!(s.relationCheck && s.relationCheck.enabled !== false);
      relationDays.value = (s.relationCheck && s.relationCheck.days) || 7;
      dndChk.checked = !!(s.doNotDisturb && s.doNotDisturb.enabled !== false);
      dndStart.value = (s.doNotDisturb && s.doNotDisturb.start) || '23:00';
      dndEnd.value = (s.doNotDisturb && s.doNotDisturb.end) || '08:00';
      const r = s.reminder || {};
      ddlDays.value = (r.deadlineLeadDays || [1]).join(',');
      ddlHours.value = (r.deadlineLeadHours || [2]).join(',');
      schedLead.value = r.scheduleLeadMinutes !== undefined ? r.scheduleLeadMinutes : 30;
    } catch {}
  }

  async function save() {
    try {
      const cur = await api.settings.get();
      const days = parseInt(relationDays.value, 10);
      await api.settings.save({
        proactivity: { level: levelSel.value },
        heartbeat: { intervalSec: parseInt(hbSec.value, 10) || 30 },
        relationCheck: { ...(cur.relationCheck || {}), enabled: relationChk.checked, days: days > 0 ? days : 7 },
        doNotDisturb: { ...(cur.doNotDisturb || {}), enabled: dndChk.checked, start: dndStart.value || '23:00', end: dndEnd.value || '08:00' },
        reminder: {
          ...(cur.reminder || {}),
          deadlineLeadDays: parseList(ddlDays.value),
          deadlineLeadHours: parseList(ddlHours.value),
          scheduleLeadMinutes: parseInt(schedLead.value, 10) || 30
        }
      });
      saveMsg.textContent = '已保存 ✓';
      setTimeout(() => { saveMsg.textContent = ''; }, 2000);
    } catch (e) {
      saveMsg.textContent = '保存失败：' + e.message;
    }
  }

  return { show: load, hide() {} };
}
