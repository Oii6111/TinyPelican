import { api } from '../api.mjs';
import { el, empty, esc } from '../ui.mjs';
import { createWechatLogin } from '../components/wechat-login.mjs';

export function mount(container) {
  empty(container);
  container.className = 'view';
  const wxLogin = createWechatLogin();

  const captureChk = el('input', { type: 'checkbox' });
  const replyChk = el('input', { type: 'checkbox' });
  const selfInput = el('input', { class: 'input', placeholder: '多个用逗号分隔，如：六壹' });
  const captureMsg = el('span', { class: 'muted' });
  const capBadge = el('span', { class: 'badge warn', text: '已关闭' });
  const voiceList = el('div');

  const captureCfg = el('div', { style: 'display:none;' },
    el('div', { class: 'field' },
      el('label', { class: 'switch' }, captureChk, ' 启用剪贴板捕获')
    ),
    el('div', { class: 'field' },
      el('label', { text: '我的微信昵称' }),
      selfInput,
      el('div', { class: 'hint', text: '用于解析时排除自己，只为「对方」建档。' })
    ),
    el('div', { class: 'field' },
      el('label', { class: 'switch' }, replyChk, ' 复制聊天后生成回复建议'),
      el('div', { class: 'hint', text: '识别私聊联系人后，根据画像与最近聊天生成三条建议。点击建议只填入微信输入框，不会自动发送。' })
    ),
    el('div', {},
      el('button', { class: 'btn btn-primary btn-sm', text: '保存', onclick: saveCapture }),
      ' ',
      captureMsg
    )
  );

  const clipboardCard = el('div', { class: 'card' },
    el('h2', {},
      el('span', { text: '📋 剪贴板捕获' }),
      ' ',
      capBadge
    ),
    el('div', { class: 'desc', text: '复制微信聊天记录后自动解析、去重、归档；语音消息在这里按顺序回填转写内容。' }),
    el('div', { class: 'actions' },
      el('button', { class: 'btn btn-ghost btn-sm', text: '配置', onclick: () => toggle(captureCfg) })
    ),
    captureCfg,
    el('h3', { text: '语音回填' }),
    voiceList
  );

  const wechatCard = el('div', { class: 'card' },
    el('h2', { text: '💬 微信通道（iLink）' }),
    el('div', { class: 'desc', text: '实时收发消息并自动进入记忆；扫码登录后凭据写入本地 config.toml。' }),
    wxLogin.el
  );

  const intentCard = el('div', { class: 'card' },
    el('h2', { text: '🧠 意图提取' }),
    el('div', { class: 'desc', text: '新消息归档后自动提取任务 / DDL / 日程 / 事项提醒 / 等待回复，并进入「主动 → 待确认行动」。' }),
    el('div', { class: 'source-item' },
      el('span', { class: 'src-icon', text: '🧠' }),
      el('div', {},
        el('div', { class: 'src-name', text: '自动提取' }),
        el('div', { class: 'src-desc', text: '高置信度自动添加，中低置信度进入待确认' })
      ),
      el('span', { class: 'src-state' }, el('span', { class: 'badge info', text: '随消息自动运行' }))
    )
  );

  const noteCard = el('div', { class: 'card' },
    el('h2', { text: '📝 手动笔记' }),
    el('div', { class: 'desc', text: '用户主动补充的画像标签与知识条目。' }),
    el('div', { class: 'empty', style: 'padding:16px 0;', text: '该能力将在后续版本接入' })
  );

  container.append(el('div', { class: 'settings-page' }, clipboardCard, wechatCard, intentCard, noteCard));

  function toggle(box) {
    box.style.display = box.style.display === 'none' ? '' : 'none';
  }

  async function saveCapture() {
    try {
      const cur = await api.settings.get();
      const r = await api.settings.save({
        selfNicknames: selfInput.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
        capture: {
          ...(cur.capture || {}),
          enabled: captureChk.checked,
          replySuggestions: {
            ...((cur.capture && cur.capture.replySuggestions) || {}),
            enabled: replyChk.checked
          }
        }
      });
      captureMsg.textContent = r && r.restarting ? '已保存 ✓，服务即将自动重启' : '已保存 ✓';
      setTimeout(() => { captureMsg.textContent = ''; }, 2500);
      refreshBadge();
    } catch (e) {
      captureMsg.textContent = '保存失败：' + e.message;
    }
  }

  async function loadVoice() {
    let items = [];
    try { items = await api.voice.list(); } catch {}
    empty(voiceList);
    if (!items.length) {
      voiceList.append(el('div', { class: 'empty', style: 'padding:12px 0;', text: '暂无待回填语音 🎉' }));
      return;
    }
    for (let i = 0; i < items.length; i++) {
      const v = items[i];
      voiceList.append(
        el('div', { class: 'item-card' },
          el('div', {},
            el('b', { text: '#' + (i + 1) + '　' }),
            ' ' + esc(v.contact || v.name || '?') + '　' + esc(v.ts || ''),
            v.content
              ? el('span', { class: 'badge info', text: '已回填' })
              : el('span', { class: 'badge warn', text: '待回填' })
          ),
          v.content ? el('div', { style: 'margin-top:6px;', text: v.content }) : null,
          el('div', { class: 'actions' },
            el('button', {
              class: 'btn btn-danger btn-sm',
              text: '跳过',
              onclick: async () => { try { await api.voice.skip(i); } catch {} loadVoice(); }
            })
          )
        )
      );
    }
  }

  async function refreshBadge() {
    try {
      const s = await api.settings.get();
      const on = !!(s.capture && s.capture.enabled);
      capBadge.textContent = on ? '已开启' : '已关闭';
      capBadge.className = 'badge ' + (on ? 'info' : 'warn');
      captureChk.checked = on;
      replyChk.checked = !!(s.capture && s.capture.replySuggestions && s.capture.replySuggestions.enabled);
      selfInput.value = (s.selfNicknames || []).join(', ');
    } catch {}
  }

  return {
    show() {
      refreshBadge();
      loadVoice();
      wxLogin.refresh();
    },
    hide() {
      wxLogin.stop();
    }
  };
}
