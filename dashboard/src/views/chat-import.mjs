// 聊天导入页
// 三条通用入口：
//   1) 思必驰（AIWorks）录音笔记 → 聊天时间线；
//   2) 其他录音产品的转写文本 → 聊天时间线；
//   3) ChatLab / TXT 聊天文件，或微信「复制」的聊天文本 → 聊天时间线。
// 导入成功后跳到联系人页查看（联系人页目前不接收预选参数，先回到列表）。
import { api } from '../api.mjs';
import { el, empty } from '../ui.mjs';
import { aiworksImport } from '../components/aiworks-import.mjs';

const MAX_FILE_BYTES = 16 * 1024 * 1024;

function parseSelfNicknames(value) {
  return [...new Set(String(value || '').split(/[,，;；\n]+/).map(name => name.trim()).filter(Boolean))];
}

export function mount(container, ctx) {
  container.className = 'view';
  empty(container);
  const page = el('div', { class: 'settings-page' });
  const header = el('div', { class: 'desc' },
    el('h1', { text: '聊天导入' }),
    el('p', { text: '把微信聊天和线下录音转写导入联系人的聊天时间线。' }));
  const body = el('div');
  const result = el('div', { role: 'status', 'aria-live': 'polite' });
  page.append(header, body, result);
  container.append(page);
  let revision = 0;

  const openHistory = () => ctx.navigate('contacts');

  function openRecording(textOnly) {
    ++revision;
    body.replaceChildren(aiworksImport({ onImported: openHistory, onBack: showSources, textOnly }));
  }

  function renderImportResult(summary, label = '聊天消息') {
    const contacts = Object.keys(summary.contacts || {});
    result.replaceChildren(
      el('p', { text: `新增 ${summary.added || 0} 条${label}${summary.format ? `（格式：${summary.format}）` : ''}。` }),
      ...contacts.map(name => el('button', { class: 'btn btn-sm', text: `查看「${name}」`, onclick: openHistory }))
    );
  }

  function openFile() {
    const current = ++revision;
    result.replaceChildren();
    const picker = el('input', { type: 'file', accept: '.jsonl,.json,.txt', id: 'chat-import-file' });
    const nickname = el('input', { class: 'input', id: 'chat-import-nickname', placeholder: '例如：小林，林同学' });
    const outcome = el('div', { role: 'status' });
    const submit = el('button', { class: 'btn btn-primary', text: '导入文件', onclick: async () => {
      const file = picker.files?.[0];
      if (!file || file.size > MAX_FILE_BYTES) {
        outcome.textContent = file ? '单个文件最多 16 MB，请拆分后导入。' : '请先选择聊天文件。';
        return;
      }
      submit.disabled = picker.disabled = nickname.disabled = true;
      outcome.textContent = '正在导入…';
      try {
        const summary = await api.chatImport.file({ mode: 'file', filename: file.name, selfNickname: nickname.value.trim(), text: await file.text() });
        if (current !== revision) return;
        outcome.textContent = `新增 ${summary.added || 0} 条聊天消息。`;
        renderImportResult(summary);
      } catch (error) {
        if (current === revision) outcome.textContent = error.message || '导入失败，请重试。';
      } finally { submit.disabled = picker.disabled = nickname.disabled = false; }
    } });
    body.replaceChildren(el('div', { class: 'card' },
      el('h2', { text: '导入聊天文件' }),
      el('p', { class: 'desc', text: '支持 ChatLab JSON / JSONL，以及包含发送者、时间和正文的 TXT 文件。' }),
      el('div', { class: 'field' }, el('label', { for: 'chat-import-file', text: '聊天文件' }), picker),
      el('div', { class: 'field' }, el('label', { for: 'chat-import-nickname', text: '我的微信昵称（文件缺少本人身份时填写）' }), nickname),
      el('div', { class: 'actions', style: 'display:flex;gap:8px;flex-wrap:wrap;' }, submit,
        el('button', { class: 'btn', text: '返回消息来源', onclick: showSources })), outcome));
  }

  // 微信「多选消息 → 复制」得到的就是一段聊天文本，和剪贴板监听走同一个解析链。
  function openClipboard() {
    const current = ++revision;
    result.replaceChildren();
    const nickname = el('input', { class: 'input', id: 'chat-import-self', placeholder: '例如：小林，林同学' });
    const text = el('textarea', { class: 'input', rows: '8', id: 'chat-import-paste', placeholder: '在微信里多选与同一个人的聊天消息，复制后粘贴到这里。' });
    const outcome = el('div', { role: 'status' });
    const submit = el('button', { class: 'btn btn-primary', text: '导入复制的聊天', onclick: async () => {
      const names = parseSelfNicknames(nickname.value);
      if (!names.length) { outcome.textContent = '请先填写自己的微信昵称。'; return; }
      submit.disabled = nickname.disabled = text.disabled = true;
      outcome.textContent = '正在导入…';
      try {
        const summary = await api.chatImport.file({ mode: 'clipboard', selfNickname: names.join('，'), text: text.value });
        if (current !== revision) return;
        outcome.textContent = `新增 ${summary.added || 0} 条聊天消息。`;
        renderImportResult(summary);
      } catch (error) {
        if (current === revision) outcome.textContent = error.message || '导入失败，请重试。';
      } finally { submit.disabled = nickname.disabled = text.disabled = false; }
    } });
    const saveNames = el('button', { class: 'btn', text: '保存昵称', onclick: async () => {
      const names = parseSelfNicknames(nickname.value);
      if (!names.length) { outcome.textContent = '请至少填写一个自己的微信昵称，用于区分你和对方。'; return; }
      saveNames.disabled = true;
      try {
        await api.settings.save({ selfNicknames: names });
        nickname.value = names.join('，');
        outcome.textContent = '昵称已保存。';
      } catch (error) { outcome.textContent = '保存失败：' + error.message; }
      finally { saveNames.disabled = false; }
    } });
    body.replaceChildren(el('div', { class: 'card' },
      el('h2', { text: '微信复制导入' }),
      el('p', { class: 'desc', text: '填写并保存自己的微信昵称，然后在微信打开与同一个人的聊天，手动多选消息并复制。小鹈鹕会识别剪贴板里的聊天格式并导入。' }),
      el('div', { class: 'field' }, el('label', { for: 'chat-import-self', text: '我的微信昵称' }), nickname,
        el('div', { class: 'hint', text: '可以填写多个自己的昵称，用中文或英文逗号分隔。请填写聊天记录中显示的名字，不要填对方的昵称。' })),
      el('div', { class: 'actions', style: 'display:flex;gap:8px;flex-wrap:wrap;' }, saveNames),
      el('div', { class: 'field' }, el('label', { for: 'chat-import-paste', text: '粘贴聊天记录' }), text),
      el('div', { class: 'actions', style: 'display:flex;gap:8px;flex-wrap:wrap;' }, submit,
        el('button', { class: 'btn', text: '返回消息来源', onclick: showSources })), outcome));
    api.settings.get().then(settings => {
      if (revision === current && !nickname.value) nickname.value = (settings.selfNicknames || []).join('，');
    }).catch(() => {});
  }

  function sourceCard(title, description, action, label, status) {
    return el('div', { class: 'card', style: 'margin-bottom:12px;' }, el('h3', { text: title }),
      el('p', { class: 'desc', text: description }), status,
      el('div', { class: 'actions' }, el('button', { class: 'btn', text: label, onclick: action })));
  }

  function showSources() {
    const current = ++revision;
    result.replaceChildren();
    const aiworks = el('small', { role: 'status', text: '正在读取连接状态…' });
    body.replaceChildren(
      el('h2', { text: '录音与聊天文件' }),
      sourceCard('思必驰录音', '连接配套 App 的账号，从云端选择已转写的录音笔记。', () => openRecording(false), '管理连接与导入', aiworks),
      sourceCard('其他录音产品', '粘贴设备或 ClawHub 导出的转写，确认联系人、开始时间和说话人后导入。', () => openRecording(true), '粘贴转写'),
      sourceCard('聊天文件', '导入 ChatLab 导出文件或有时间与发送者的聊天文本。', openFile, '选择文件'),
      sourceCard('微信复制', '在微信里多选消息复制，粘贴后按昵称区分你和对方。', openClipboard, '粘贴聊天记录'));
    api.aiworks.status().then(state => {
      if (revision === current) aiworks.textContent = state.error || (state.connected ? '已连接' : '未连接');
    }).catch(() => { if (revision === current) aiworks.textContent = '暂时无法读取连接状态'; });
  }

  return {
    show(params) { if (params?.source === 'aiworks') openRecording(false); else showSources(); },
    hide() { ++revision; }
  };
}
