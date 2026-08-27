import { api } from '../api.mjs';
import { el, esc, empty } from '../ui.mjs';

// 微信通道登录组件：状态 + 扫码登录 + 退出，供设置页与记忆输入页复用
export function createWechatLogin() {
  const statusEl = el('div', { style: 'font-size:14px;margin-bottom:12px;', text: '检测中…' });
  const qrBox = el('div');
  const qrStatus = el('div', { class: 'muted', style: 'margin-top:8px;' });
  const qrWrap = el('div', { style: 'display:none;margin-bottom:12px;' }, qrBox, qrStatus);
  const loginBtn = el('button', { class: 'btn btn-confirm', text: '扫码登录' });
  const logoutBtn = el('button', { class: 'btn', text: '退出登录' });
  const box = el('div', {}, statusEl, qrWrap, el('div', { class: 'actions' }, loginBtn, logoutBtn));

  let pollToken = 0;
  let wxTimer = null;

  async function refresh() {
    try {
      const d = await api.wechat.status();
      statusEl.textContent = d.configured
        ? '🟢 已登录（账号 ' + (d.accountId || '') + '）'
        : '⚪ 未登录';
    } catch {}
  }

  async function startLogin() {
    pollToken += 1;
    loginBtn.disabled = true;
    qrWrap.style.display = 'block';
    qrStatus.textContent = '正在获取二维码…';
    try {
      const d = await api.wechat.loginStart();
      if (d.qrcodeUrl && /^https?:/.test(d.qrcodeUrl)) {
        qrBox.innerHTML = '<iframe src="' + esc(d.qrcodeUrl) + '" style="width:260px;height:260px;border:1px solid var(--border);border-radius:10px;"></iframe>';
      } else {
        empty(qrBox);
        qrBox.append(el('div', { class: 'hint' },
          '请打开链接扫码：',
          el('a', { href: d.qrcodeUrl || '#', target: '_blank', text: d.qrcodeUrl || '' })
        ));
      }
      qrStatus.textContent = '请用手机微信扫码';
      poll(d.sessionKey);
    } catch (e) {
      qrStatus.textContent = '失败：' + e.message;
      loginBtn.disabled = false;
    }
  }

  async function poll(sessionKey) {
    const token = pollToken;
    if (wxTimer) clearTimeout(wxTimer);
    try {
      const d = await api.wechat.loginCheck(sessionKey);
      if (token !== pollToken) return;
      if (d.status === 'waiting') qrStatus.textContent = '等待扫码…';
      else if (d.status === 'scanned') qrStatus.textContent = '已扫码，请在手机微信上确认';
      else if (d.status === 'confirmed') {
        qrStatus.textContent = '确认中…';
        try {
          await api.wechat.loginConfirm(sessionKey);
          if (token !== pollToken) return;
          qrStatus.textContent = '登录成功，核心正在重启，页面即将刷新…';
          setTimeout(() => location.reload(), 4500);
          return;
        } catch (e) {
          if (token !== pollToken) return;
          qrStatus.textContent = '确认失败：' + e.message;
          loginBtn.disabled = false;
          return;
        }
      } else if (d.status === 'need_verifycode') {
        qrStatus.textContent = '请在手机微信输入配对码';
      } else if (d.status === 'expired') {
        qrStatus.textContent = '二维码已过期，请重新扫码';
        loginBtn.disabled = false;
        return;
      } else {
        qrStatus.textContent = '状态：' + d.status;
      }
      if (token === pollToken) wxTimer = setTimeout(() => poll(sessionKey), 3000);
    } catch (e) {
      if (token !== pollToken) return;
      qrStatus.textContent = '查询失败：' + e.message + '，请重试';
      loginBtn.disabled = false;
    }
  }

  loginBtn.onclick = startLogin;
  logoutBtn.onclick = async () => {
    if (!confirm('退出微信登录？核心会自动重启。')) return;
    pollToken += 1;
    try { await api.wechat.logout(); } catch {}
    alert('已退出，核心正在重启…');
    setTimeout(() => location.reload(), 4500);
  };

  return {
    el: box,
    refresh,
    stop() {
      pollToken += 1;
      if (wxTimer) clearTimeout(wxTimer);
    }
  };
}
