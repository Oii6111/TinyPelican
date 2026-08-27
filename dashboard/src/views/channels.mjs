import { api } from '../api.mjs';
import { el, empty } from '../ui.mjs';

export function mount(container, ctx) {
  empty(container);
  container.className = 'view';
  const list = el('div', { class: 'channel-grid' });
  container.append(
    el('div', { class: 'card' },
      el('h2', { text: '渠道列表' }),
      el('div', { class: 'desc', text: '管理所有接入 Agent 的消息渠道。渠道负责双向消息收发；异常时会在顶部状态栏告警。' }),
      list
    )
  );

  async function load() {
    empty(list);
    let wx = null;
    try { wx = await api.wechat.status(); } catch {}
    const wxOk = !!(wx && wx.configured);
    list.append(
      el('div', { class: 'channel-card' },
        el('div', { class: 'channel-head' },
          el('span', { class: 'channel-icon', text: '💬' }),
          el('div', {},
            el('div', { class: 'channel-name', text: '微信' }),
            el('div', { class: 'channel-type', text: 'iLink 个人号 · 双向消息' })
          ),
          el('span', { class: 'badge ' + (wxOk ? 'info' : 'warn'), text: wxOk ? '已接入' : '未接入' })
        ),
        el('div', { class: 'channel-foot' },
          el('span', { class: 'muted', text: wxOk ? '账号 ' + (wx.accountId || '') : '扫码登录后即可收发消息与主动推送' }),
          el('button', { class: 'btn btn-ghost btn-sm', text: wxOk ? '配置' : '去登录', onclick: () => ctx.navigate('memory-input') })
        )
      )
    );
    const future = [
      ['🌐', '网页', 'Web Chat'],
      ['📮', '邮件', 'SMTP / IMAP'],
      ['📡', 'API', 'Webhook'],
      ['💼', 'Slack', 'App'],
      ['☁️', '飞书', 'App']
    ];
    for (const [icon, name, type] of future) {
      list.append(
        el('div', { class: 'channel-card ghost' },
          el('div', { class: 'channel-head' },
            el('span', { class: 'channel-icon', text: icon }),
            el('div', {},
              el('div', { class: 'channel-name', text: name }),
              el('div', { class: 'channel-type', text: type })
            ),
            el('span', { class: 'badge', text: '未接入' })
          ),
          el('div', { class: 'channel-foot' },
            el('span', { class: 'muted', text: '规划中' }),
            el('button', { class: 'btn btn-ghost btn-sm', text: '接入', disabled: true })
          )
        )
      );
    }
  }

  return { show: load, hide() {} };
}
