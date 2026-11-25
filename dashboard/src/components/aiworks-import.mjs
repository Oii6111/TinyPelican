// 思必驰（AIWorks）录音转写导入面板
// 也兼「其他录音产品」的粘贴导入：粘贴转写 → 预览分段 → 确认联系人与说话人身份 → 落库。
// 所有网络访问都走 api.aiworks.*（核心代发），页面本身不直接访问 aiworks.cn。
import { api } from '../api.mjs';
import { el } from '../ui.mjs';

const actions = (...children) => el('div', { class: 'actions', style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;' }, ...children);
const field = (labelText, control, hint) => el('div', { class: 'field' }, el('label', { text: labelText }), control, hint ? el('div', { class: 'hint', text: hint }) : null);

function localInputTime(value) {
  const date = new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}

export function aiworksImport({ onImported, onBack, textOnly = false }) {
  const panel = el('section', { class: 'card' });
  const body = el('div');
  const notice = el('p', { role: 'status', 'aria-live': 'polite' });
  let pending = false;
  let connection;

  const button = (label, action, primary = false) => el('button', {
    type: 'button', class: primary ? 'btn btn-primary' : 'btn', text: label, onclick: action
  });

  async function run(work) {
    if (pending) return;
    pending = true;
    notice.textContent = '';
    const fields = [...panel.querySelectorAll('button, input, select, textarea')].filter(item => !item.disabled);
    for (const item of fields) item.disabled = true;
    try { await work(); }
    catch (error) { notice.textContent = error.message || '操作失败，请重试。'; }
    finally {
      pending = false;
      for (const item of fields) item.disabled = false;
    }
  }

  function connectionForm() {
    const token = el('input', { class: 'input', type: 'password', autocomplete: 'off', id: 'aiworks-token' });
    body.replaceChildren(
      el('ol', {},
        el('li', { text: '在手机上打开已有的思必驰配套 App，在设备管理里添加录音卡或办公本。已配对的设备可以继续使用。' }),
        el('li', {}, '将录音转写同步到云端，再到 ', el('a', { href: 'https://aiworks.cn', target: '_blank', rel: 'noopener noreferrer', text: '思必驰开放平台' }), ' 为同一账号获取可读取笔记（NOTE_READ）的授权码。')),
      field('思必驰授权码', token),
      actions(
        button('连接思必驰账号', () => run(async () => {
          connection = await api.aiworks.connect({ token: token.value });
          token.value = '';
          connected();
          await listNotes(1);
        }), true),
        button('粘贴已有转写', () => pasted()))
    );
  }

  function connected() {
    body.replaceChildren(el('p', { text: connection.persistent ? '已连接思必驰账号。' : '已连接思必驰账号，重启后需重新连接。' }),
      actions(button('读取云端笔记', () => run(() => listNotes(1)), true),
        button('更换授权码', connectionForm), button('粘贴已有转写', () => pasted()),
        button('断开账号', () => run(disconnect))));
  }

  async function disconnect() {
    connection = await api.aiworks.disconnect();
    connectionForm();
  }

  async function listNotes(page) {
    const result = await api.aiworks.list(page);
    const list = el('ul', {}, ...result.notes.map(note => el('li', { style: 'margin:6px 0;' },
      button(note.title || '未命名笔记', () => run(async () => {
        const preview = await api.aiworks.note(note.uid);
        await review(preview, { uid: preview.uid, version: preview.version }, () => run(() => listNotes(page)));
      })),
      el('small', { text: note.createdAt || '' })
    )));
    body.replaceChildren(
      el('p', { text: '选择已同步的录音笔记。' }),
      result.notes.length ? list : el('p', { class: 'empty', text: '当前没有可读取的笔记。请在思必驰 App 中完成转写并同步。' }),
      actions(
        page > 1 ? button('上一页', () => run(() => listNotes(page - 1))) : null,
        result.hasMore ? button('下一页', () => run(() => listNotes(page + 1))) : null,
        button('刷新列表', () => run(() => listNotes(page))),
        button('粘贴已有转写', () => pasted()),
        button('更换授权码', connectionForm),
        button('断开账号', () => run(disconnect)))
    );
  }

  function pasted(raw = '', initialTime) {
    const text = el('textarea', { class: 'input', rows: '8', id: 'aiworks-transcript', maxlength: '120000' });
    text.value = raw;
    body.replaceChildren(
      field('转写文本', text),
      el('p', { class: 'hint', text: '粘贴录音产品或 ClawHub 导出的转写。如果文本没有说话人标签，请逐段整理为「我：…」「对方：…」，可在每行开头保留 00:01:23 这样的时间标记。' }),
      actions(button('预览转写', () => run(async () => {
        const input = { text: text.value };
        const preview = await api.aiworks.previewText(input);
        await review({ ...preview, createdAt: initialTime, raw: input.text }, input, () => pasted(input.text, initialTime));
      }), true), textOnly ? null : button(connection?.connected ? '返回云端笔记' : '返回账号连接', () => connection?.connected ? run(() => listNotes(1)) : connectionForm()))
    );
  }

  async function review(preview, input, back) {
    const contacts = await api.contacts.list();
    const names = el('datalist', { id: 'aiworks-contacts' }, ...contacts.map(contact =>
      el('option', { value: contact.name, label: contact.remark || contact.name })));
    const contact = el('input', { class: 'input', list: 'aiworks-contacts', maxlength: '120', id: 'aiworks-contact' });
    const start = el('input', { class: 'input', type: 'datetime-local', step: '1', id: 'aiworks-start', value: preview.createdAt ? localInputTime(preview.createdAt) : '' });
    const speakers = [...new Set(preview.segments.map(segment => segment.speaker))];
    const roles = speakers.map(speaker => [speaker, el('select', { class: 'select' },
      ...[['', '请选择身份'], ['self', '我'], ['contact', '该联系人'], ['skip', '跳过']].map(([value, text]) => el('option', { value, text })))]);
    const segments = el('ol', { 'aria-label': '录音转写预览' }, ...preview.segments.map(segment => el('li', { style: 'margin:8px 0;' },
      el('strong', { text: [segment.time, segment.speaker || '未标注说话人'].filter(Boolean).join(' · ') }),
      el('p', { text: segment.text }))));
    body.replaceChildren(
      el('h3', { text: preview.title || '确认转写' }),
      field('归入联系人（可选已有联系人或输入新姓名）', contact), names,
      field('录音开始时间', start, '默认使用笔记创建时间。如果和录音开始时间不同，请手动修改。'),
      el('p', { text: '核对每个说话人是谁。多人录音中，本次只导入你和选定联系人的发言。' }),
      ...roles.map(([speaker, select]) => field(speaker || '未标注说话人', select)),
      segments,
      actions(button('导入聊天记录', () => run(async () => {
        const date = new Date(start.value);
        if (!contact.value.trim() || Number.isNaN(date.getTime())) throw new Error('请填写联系人和录音开始时间。');
        if (roles.some(([, control]) => !control.value)) throw new Error('请确认每位说话人的身份。');
        const result = await api.aiworks.commit({ ...input, contact: contact.value.trim(), startedAt: date.toISOString(),
          roles: Object.fromEntries(roles.map(([speaker, control]) => [speaker, control.value])) });
        body.replaceChildren(el('p', { text: result.added ? `已向 ${result.contact} 的聊天记录导入 ${result.added} 段录音转写。` : '所选发言已导入过。' }),
          actions(button('查看聊天记录', () => onImported(result.contact), true), button('继续导入', back)));
      }), true), button('返回', back),
      button('手动整理文本', () => pasted(preview.raw, preview.createdAt)))
    );
  }

  panel.append(el('h2', { text: textOnly ? '导入录音转写' : '思必驰录音设备' }), body, notice, actions(button('返回聊天导入', onBack)));
  if (textOnly) { pasted(); return panel; }
  body.append(el('p', { text: '正在读取连接状态…' }));
  run(async () => {
    connection = await api.aiworks.status();
    if (connection.connected) connected();
    else connectionForm();
    notice.textContent = connection.error || '';
  });
  return panel;
}
