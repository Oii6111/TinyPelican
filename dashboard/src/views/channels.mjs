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
          el('span', { class: 'muted', text: wxOk ? '账号 ' + (wx.accountId || '') : '扫码登录后即可收发消息与接收通知' }),
          el('button', { class: 'btn btn-ghost btn-sm', text: wxOk ? '配置' : '去登录', onclick: () => ctx.navigate('settings') })
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
    let search = {};
    try { search = await api.webSearch.status(); } catch {}
    const result = el('span', { class: 'muted', text: search.lastTest ? (search.lastTest.ok ? '上次连接测试成功' : search.lastTest.error) : '尚未测试连接' });
    const test = el('button', { class: 'btn btn-sm', text: '测试连接', onclick: async () => {
      test.disabled = true; result.textContent = '测试中…';
      try { const data = await api.webSearch.test(); result.textContent = `连接成功 · ${data.results.length} 条来源`; }
      catch (error) { result.textContent = error.message; }
      finally { test.disabled = false; }
    } });
    list.append(el('div', { class: 'channel-card' },
      el('div', { class: 'channel-head' }, el('strong', { text: '🌐 联网搜索' }), el('span', { class: 'badge', text: search.enabled ? (search.ready ? '已启用' : '待配置') : '已关闭' })),
      el('p', { text: `当前服务：${search.provider === 'moonshot' ? 'Kimi' : 'SearXNG'} · 为“聊点新鲜的”提供来源` }), result,
      el('div', { class: 'channel-foot' }, test, el('button', { class: 'btn btn-sm', text: '配置', onclick: () => { sessionStorage.setItem('settings-section', 'web-search'); ctx.navigate('settings'); } }))));
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
