import { api } from '../api.mjs';
import { el, empty } from '../ui.mjs';

export function mount(container, ctx) {
  container.className = 'view';
  const capBadge = el('span', { class: 'badge warn', text: '读取状态中' });
  const voiceList = el('div');
  container.append(el('div', { class: 'settings-page' },
    el('div', { class: 'card' },
      el('h2', { text: '记忆输入' }),
      el('div', { class: 'desc', text: '管理语音转写、剪贴板和通道消息的录入。邮件已单独放在记忆下的邮件页面。' }),
      el('div', { class: 'actions' }, el('span', { text: '录入状态' }), capBadge,
        el('button', { class: 'btn btn-ghost btn-sm', text: '前往设置', onclick: () => ctx.navigate('settings') })),
      el('h3', { text: '待处理语音记录' }), voiceList
    ),
    el('div', { class: 'card' }, el('h2', { text: '导入与录入' }),
      el('div', { class: 'desc', text: '消息导入成功后会进入后台处理队列，并根据设置生成总结和待确认意图。' }))
  ));

  async function loadVoice() {
    empty(voiceList);
    let items;
    try { items = await api.voice.list(); } catch { voiceList.append(el('div', { class: 'empty', text: '语音记录读取失败，请刷新页面重试。' })); return; }
    if (!items.length) { voiceList.append(el('div', { class: 'empty', text: '暂无待处理语音记录。' })); return; }
    items.forEach((voice, index) => voiceList.append(el('div', { class: 'item-card' },
      el('div', {}, el('b', { text: `#${index + 1} ` }), `${voice.contact || voice.name || '未知联系人'} · ${voice.ts || ''}`,
        el('span', { class: `badge ${voice.content ? 'info' : 'warn'}`, text: voice.content ? '已转写' : '待处理' })),
      voice.content ? el('div', { class: 'meta', text: voice.content }) : null,
      el('button', { class: 'btn btn-danger btn-sm', text: '跳过', onclick: async () => { await api.voice.skip(index); await loadVoice(); } })
    )));
  }

  async function refreshBadge() {
    try {
      const settings = await api.settings.get();
      const enabled = !!settings.capture?.enabled;
      capBadge.textContent = enabled ? '已开启' : '已关闭';
      capBadge.className = `badge ${enabled ? 'info' : 'warn'}`;
    } catch { capBadge.textContent = '状态未知'; }
  }

  return { show() { refreshBadge(); loadVoice(); }, hide() {} };
}
