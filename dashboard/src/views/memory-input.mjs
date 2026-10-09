import { api } from '../api.mjs';
import { el, empty } from '../ui.mjs';

export function mount(container, ctx) {
  empty(container);
  container.className = 'view';
  const capBadge = el('span', { class: 'badge warn', text: '读取状态中' });
  const voiceList = el('div');
  container.append(el('div', { class: 'settings-page' },
    el('div', { class: 'card' },
      el('h2', { text: '记忆输入' }),
      el('div', { class: 'desc', text: '剪贴板捕获、本人昵称、回复建议和微信登录已统一移至设置页。' }),
      el('div', { class: 'actions' },
        el('span', { text: '剪贴板捕获：' }), capBadge,
        el('button', { class: 'btn btn-ghost btn-sm', text: '前往设置', onclick: () => ctx.navigate('settings') })
      ),
      el('h3', { text: '语音回填' }), voiceList
    ),
    el('div', { class: 'card' },
      el('h2', { text: '意图提取' }),
      el('div', { class: 'desc', text: '新消息归档后自动提取任务、日程与提醒。识别结果进入待确认列表，确认后才创建正式事项。' })
    ),
    el('div', { class: 'card' },
      el('h2', { text: '手动笔记' }),
      el('div', { class: 'empty', text: '该能力将在后续版本接入' })
    )
  ));

  async function loadVoice() {
    empty(voiceList);
    let items;
    try { items = await api.voice.list(); } catch {
      voiceList.append(el('div', { class: 'empty', text: '语音列表加载失败，请重新进入页面重试。' }));
      return;
    }
    if (!items.length) {
      voiceList.append(el('div', { class: 'empty', text: '暂无待回填语音 🎉' }));
      return;
    }
    items.forEach((voice, index) => {
      voiceList.append(el('div', { class: 'item-card' },
        el('div', {}, el('b', { text: `#${index + 1}　` }),
          `${voice.contact || voice.name || '?'}　${voice.ts || ''}`,
          el('span', { class: 'badge ' + (voice.content ? 'info' : 'warn'), text: voice.content ? '已回填' : '待回填' })
        ),
        voice.content ? el('div', { class: 'meta', text: voice.content }) : null,
        el('button', { class: 'btn btn-danger btn-sm', text: '跳过', onclick: async () => {
          try { await api.voice.skip(index); await loadVoice(); } catch (error) { alert('跳过失败：' + error.message); }
        } })
      ));
    });
  }

  async function refreshBadge() {
    try {
      const settings = await api.settings.get();
      const enabled = !!settings.capture?.enabled;
      capBadge.textContent = enabled ? '已开启' : '已关闭';
      capBadge.className = 'badge ' + (enabled ? 'info' : 'warn');
    } catch { capBadge.textContent = '状态不可用'; }
  }

  return { show() { refreshBadge(); loadVoice(); }, hide() {} };
}
