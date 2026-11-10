import { el } from '../ui.mjs';

function formatDate(value, options) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间待确认' : date.toLocaleString('zh-CN', options);
}

export function renderDashboard(data, ctx, onImport) {
  const primary = data.primary;
  const name = primary.label || primary.contactName;
  const coach = type => ctx.navigate('romance-coach', { relationshipId: primary.id, type });
  const relationships = () => ctx.navigate('romance-relationships');
  const schedule = () => ctx.navigate('schedule-dashboard');
  const heading = (title, label, action) => el('div', { class: 'romance-dash-section-head' },
    el('h2', { text: title }), label ? el('button', { class: 'btn btn-ghost btn-sm', text: label, onclick: action }) : null);
  const tasks = [
    { type: 'reply', symbol: '↗', title: '帮我想想怎么回复', description: '把想说的话，变成自然的表达。', label: '回复指导' },
    { type: 'analysis', symbol: '♡', title: '理解彼此的感受', description: '看看对话里的情绪、需求与边界。', label: '情绪分析' },
    { type: 'review', symbol: '↺', title: '复盘最近的聊天', description: '回看沟通中的小细节，找到下一步。', label: '对话复盘' }
  ];
  const schedules = data.schedules || [];
  return el('div', { class: 'romance-dashboard' },
    el('header', { class: 'romance-dash-header' },
      el('div', {}, el('span', { class: 'romance-kicker', text: '小鹈鹕 · 关系陪伴' }),
        el('h1', { text: '让每一次靠近，都更从容' }), el('p', { text: '从今天的一次好好沟通开始。' })),
      el('span', { class: 'romance-dash-date', text: formatDate(Date.now(), { month: 'long', day: 'numeric', weekday: 'long' }) })),
    el('section', { class: 'romance-dash-overview', 'aria-label': '当前关系概览' },
      el('div', { class: 'romance-dash-person' },
        el('span', { class: 'romance-avatar', 'aria-hidden': 'true', text: Array.from(name)[0] || '♡' }),
        el('div', {}, el('span', { class: 'romance-card-label', text: '正在关注的关系' }), el('h2', { text: name }),
          el('span', { class: 'romance-dash-stage', text: [primary.type, primary.stage].filter(Boolean).join(' · ') || '慢慢了解彼此' })),
        el('button', { class: 'btn btn-ghost btn-sm', text: '管理关系', onclick: relationships })),
      el('div', { class: 'romance-dash-facts' },
        el('div', {}, el('strong', { text: String(primary.messageCount || 0) }), el('span', { text: '已导入聊天' })),
        el('div', {}, el('strong', { text: primary.lastMessageAt ? formatDate(primary.lastMessageAt, { month: 'numeric', day: 'numeric' }) : '暂无记录' }), el('span', { text: '最近聊天记录' })),
        el('div', {}, el('strong', { text: String(data.relationships?.length || 1) }), el('span', { text: '关系档案' }))),
      el('div', { class: 'romance-dash-goal' }, el('span', { class: 'romance-card-label', text: '近期的小目标' }),
        el('p', { text: primary.goal || '你希望和对方一起，发生什么小小的改变？' }),
        el('button', { class: 'btn btn-ghost btn-sm', text: primary.goal ? '调整目标' : '写下一个目标', onclick: relationships }))),
    el('section', { 'aria-label': '沟通教练' }, heading('今天，想聊点什么？'),
      el('div', { class: 'romance-dash-coaches' }, ...tasks.map(task =>
        el('button', { class: `romance-dash-coach ${task.type === 'reply' ? 'is-featured' : ''}`, onclick: () => coach(task.type) },
          el('span', { class: 'romance-dash-coach-top' }, el('span', { class: 'romance-dash-symbol', 'aria-hidden': 'true', text: task.symbol }), el('span', { text: task.label })),
          el('strong', { text: task.title }), el('span', { class: 'romance-dash-description', text: task.description }),
          el('span', { class: 'romance-dash-link', 'aria-hidden': 'true', text: '开始聊聊  →' }))))),
    el('div', { class: 'romance-dash-bottom' },
      el('section', { class: 'romance-dash-panel' }, heading('给今天的一点建议'),
        el('p', { class: 'romance-dash-suggestion', text: data.todaySuggestion || '留一点时间，认真听听彼此的感受。' }),
        el('span', { class: 'romance-dash-description', text: '按自己的节奏来，一次小行动就很好。' }),
        el('button', { class: 'btn btn-ghost btn-sm', text: '和教练聊聊', onclick: () => coach('analysis') })),
      el('section', { class: 'romance-dash-panel' }, heading('近期安排', '查看日程', schedule),
        schedules.length ? el('div', { class: 'romance-dash-agenda' }, ...schedules.slice(0, 3).map(item =>
          el('button', { class: 'romance-dash-agenda-item', onclick: schedule },
            el('span', { text: item.startAt ? formatDate(item.startAt, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '时间待定' }),
            el('strong', { text: item.title || '未命名日程' })))) :
          el('div', { class: 'romance-dash-empty' }, el('p', { text: '还没有安排，留一点时间给彼此。' }),
            el('button', { class: 'btn btn-ghost btn-sm', text: '去安排一次见面', onclick: schedule })))),
    el('footer', { class: 'romance-dash-footer' },
      el('span', { text: '有新的聊天？在微信多选消息并复制，继续积累你们的故事。' }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '导入与添加关系', onclick: onImport })));
}
