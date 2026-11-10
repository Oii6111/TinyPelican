import { api } from '../api.mjs';
import { el } from '../ui.mjs';
import { renderDashboard } from './romance-home-dashboard.mjs';

export function mount(container, ctx) {
  let data;
  let visible = false;
  let busy = false;
  let imported = [];
  let notice = '';
  let mode = 'clipboard';
  let file = null;
  let selfNickname = '';
  let savedNicknames = [];
  let waiting = false;
  let captureConfigured = false;
  let pollTimer = null;
  let selected = '';
  let importing = false;
  container.classList.add('romance-view', 'romance-onboarding');

  function render() {
    const primary = data?.primary;
    if (primary && !importing) {
      container.replaceChildren(renderDashboard(data, ctx, () => {
        importing = true;
        imported = [];
        notice = '';
        render();
        schedulePoll();
      }));
      return;
    }
    const needsRelationship = imported.length > 0;
    const start = !primary || importing;
    const title = needsRelationship ? '这段聊天，属于谁？' : start ? '从你们的微信聊天开始' : `继续了解你和${primary.label || primary.contactName}的关系`;
    const subtitle = needsRelationship ? '确认你想了解的对象，聊天记录将用于这段关系的回复指导与复盘。' : start ? '先导入一段聊天，建立关系档案，再一起看看下一步怎么聊。' : '关系档案已经准备好。带着一个具体问题，开始今天的沟通练习。';
    const panel = el('div', { class: 'romance-start-panel' });
    if (start && !needsRelationship) {
      const picker = el('input', { type: 'file', accept: '.jsonl,.txt,.json', disabled: busy, id: 'romance-chat-file', onchange: event => { file = event.target.files?.[0] || null; render(); } });
      const nickname = el('input', { class: 'input', id: 'romance-self-nickname', value: selfNickname, disabled: busy, placeholder: '填写你自己的微信昵称', oninput: event => { selfNickname = event.target.value; } });
      panel.append(
        el('h2', { text: '第一步 · 导入微信聊天' }),
        ...(mode === 'file' ? [
          el('p', { text: '选择 JSONL 或 TXT 聊天文件。支持 ChatLab 标准 JSONL，以及包含发送者、时间和内容的聊天 TXT；你可以自行使用第三方工具导出或转换。' }),
          el('label', { for: 'romance-chat-file', text: file ? `已选择：${file.name}` : '选择聊天文件' }), picker,
          el('small', {}, '格式参考：', el('a', { href: 'https://github.com/ChatLab/ChatLab', target: '_blank', rel: 'noopener noreferrer', text: 'ChatLab' })),
          el('label', { for: 'romance-self-nickname', text: '我的微信昵称（文件未包含本人身份时填写）' }), nickname
        ] : [
          el('p', { text: '填写并保存自己的微信昵称，然后去微信多选同一个人的聊天消息并复制。小鹈鹕会自动识别、导入，回来即可确认对象。' }),
          el('label', { for: 'romance-self-nickname', text: '我的微信昵称（必填）' }), nickname,
          el('small', { text: '填写聊天消息中显示的本人昵称，用于区分你和对方。' }),
          el('div', { class: 'romance-capture-status', role: 'status' }, el('strong', { text: waiting ? '等待你在微信中复制聊天消息…' : '先保存昵称，开启自动导入' }), el('span', { text: waiting ? '去微信多选消息并复制，无需回到这里粘贴。识别成功后会自动进入下一步。' : '昵称只需设置一次，之后复制符合格式的消息就会自动导入。' }))
        ]),
        el('button', { class: 'btn btn-primary', disabled: busy, text: busy ? '正在处理…' : mode === 'file' ? '导入文件，下一步' : waiting ? '更新昵称并继续等待' : '保存昵称，开启自动导入', onclick: mode === 'file' ? importChat : enableCapture }),
        el('button', { class: 'btn btn-ghost romance-import-alternative', disabled: busy, text: mode === 'file' ? '返回微信自动导入（推荐）' : '已有聊天文件？导入 JSONL / TXT', onclick: () => { mode = mode === 'file' ? 'clipboard' : 'file'; notice = ''; render(); schedulePoll(); } })
      );
    } else if (needsRelationship) {
      const select = el('select', { class: 'select', id: 'romance-import-contact', disabled: busy, onchange: event => { selected = event.target.value; } }, ...imported.map(name => el('option', { value: name, text: name, selected: selected === name })));
      panel.append(el('h2', { text: '第二步 · 创建关系档案' }), el('label', { for: 'romance-import-contact', text: '选择这次导入的对象' }), select,
        el('button', { class: 'btn btn-primary', text: busy ? '正在创建…' : '创建这段关系', disabled: busy, onclick: createRelationship }));
    } else {
      panel.append(el('h2', { text: '第三步 · 开始你的第一次指导' }), el('p', { text: '不知道怎么回复，或想理解一次对话？选择一个方向即可。' }),
        el('div', { class: 'romance-start-actions' },
          el('button', { class: 'btn btn-primary', text: '帮我想想怎么回复', onclick: () => ctx.navigate('romance-coach', { relationshipId: primary.id, type: 'reply' }) }),
          el('button', { class: 'btn', text: '复盘最近的聊天', onclick: () => ctx.navigate('romance-coach', { relationshipId: primary.id, type: 'review' }) }))
      );
    }
    if (notice) panel.append(el('p', { class: 'romance-start-notice', role: 'status', text: notice }));
    const step = needsRelationship ? 2 : start ? 1 : 3;
    container.replaceChildren(
      el('header', { class: 'romance-start-heading' }, el('span', { class: 'romance-kicker', text: '小鹈鹕 · 关系陪伴' }), el('h1', { text: title }), el('p', { text: subtitle })),
      el('ol', { class: 'romance-start-steps', 'aria-label': '使用步骤' }, ...['导入微信聊天', '确认对象，创建关系', '获取回复指导与复盘'].map((label, index) => el('li', { class: index + 1 === step ? 'current' : '', 'aria-current': index + 1 === step ? 'step' : null }, el('span', { text: String(index + 1) }), el('strong', { text: label })))),
      panel,
      el('div', { class: 'romance-start-footer' },
        primary ? el('button', { class: 'btn btn-ghost', disabled: busy, text: importing ? '返回当前关系' : '导入另一段聊天', onclick: () => { importing = !importing; imported = []; notice = ''; render(); schedulePoll(); } }) : null,
        el('button', { class: 'btn btn-ghost', disabled: busy, text: '已有联系人？查看我的关系', onclick: () => ctx.navigate('romance-relationships') }))
    );
  }

  async function importChat() {
    if (mode === 'file' && !file) { notice = '请先选择 JSONL 或 TXT 聊天文件。'; render(); return; }
    if (mode === 'file' && file.size > 16 * 1024 * 1024) { notice = '单个文件暂限 16 MB，请拆分后导入。'; render(); return; }
    busy = true;
    notice = '';
    render();
    try {
      const text = await file.text();
      const response = await fetch('/api/import/content', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'file', filename: file.name, selfNickname: selfNickname.trim(), text }) });
      const summary = await response.json();
      imported = Object.keys(summary.contacts || {});
      selected = imported[0] || '';
      if (imported.length) notice = `已识别 ${imported.length} 位联系人，新增 ${summary.added || 0} 条消息。${response.ok ? '' : '部分文件未导入，可以先为已导入的对象创建关系。'}`;
      else notice = summary.error || summary.files?.find(file => file.error)?.error || '没有识别到聊天对象，请检查文件是否包含姓名、时间和消息内容。';
    } catch { notice = '导入失败，请检查服务连接后重试。'; }
    finally { busy = false; if (visible) render(); }
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (visible && mode === 'clipboard' && !imported.length && (!data?.primary || importing)) pollTimer = setTimeout(checkCapture, 1800);
  }

  function useContacts(contacts) {
    const linked = new Set((data?.relationships || []).map(item => item.contactName));
    const candidates = contacts.filter(contact => !savedNicknames.includes(contact.name) && !linked.has(contact.name) && (Number(contact.messages || 0) > 0 || Number(contact.lastMessageId || 0) > 0));
    if (!candidates.length) return false;
    imported = candidates.map(contact => contact.name);
    if (!imported.includes(selected)) selected = imported[0];
    notice = '已从联系人聊天记录中找到已入库的对话，请确认对象并创建关系。';
    return true;
  }

  async function checkCapture() {
    try {
      const contacts = await api.contacts.list();
      if (!visible || busy || mode !== 'clipboard' || imported.length) return;
      if (useContacts(contacts)) render();
      else if (notice.startsWith('暂时无法读取')) { notice = ''; render(); }
    } catch {
      if (visible && !busy) {
        notice = '暂时无法读取联系人聊天记录，正在重试。若持续失败，请检查核心服务是否正常启动。';
        render();
      }
    }
    finally { schedulePoll(); }
  }

  async function enableCapture() {
    const nickname = selfNickname.trim();
    if (!nickname) { notice = '请先填写自己的微信昵称。'; render(); return; }
    busy = true;
    notice = '';
    render();
    try {
      const contacts = await api.contacts.list();
      const settings = await api.settings.get();
      const names = [...new Set([...(settings.selfNicknames || []), nickname])];
      if (!settings.capture?.enabled || !settings.selfNicknames?.includes(nickname)) {
        await api.settings.save({ selfNicknames: names, capture: { enabled: true } });
      }
      savedNicknames = names;
      captureConfigured = true;
      waiting = true;
      notice = '昵称已保存。请在微信中批量复制消息，入库后会在这里显示聊天对象。';
      useContacts(contacts);
    } catch (error) { notice = error.message || '开启失败，请重试。'; }
    finally { busy = false; if (visible) render(); schedulePoll(); }
  }

  async function createRelationship() {
    if (!selected || busy) return;
    busy = true;
    notice = '';
    render();
    try {
      const state = await api.romance.relationships.list();
      const existing = state.relationships.find(item => item.contactName === selected);
      const relationship = existing || (await api.romance.relationships.create({ contactName: selected, type: '正在了解', stage: '了解中' })).relationship;
      await api.romance.relationships.setPrimary(relationship.id);
      data = await api.romance.home();
      imported = [];
      importing = false;
      notice = '关系档案已准备好，可以开始指导了。';
    } catch (error) { notice = error.message || '创建失败，聊天记录已保留，请重试。'; }
    finally { busy = false; if (visible) render(); }
  }

  async function load() {
    try {
      const [home, settings, contacts] = await Promise.all([api.romance.home(), api.settings.get(), api.contacts.list()]);
      data = home;
      if (!captureConfigured) {
        savedNicknames = settings.selfNicknames || [];
        if (!selfNickname) selfNickname = savedNicknames[0] || '';
        waiting = settings.capture?.enabled === true && savedNicknames.length > 0;
        captureConfigured = true;
      }
      if (!busy && mode === 'clipboard' && !imported.length && (!data?.primary || importing)) useContacts(contacts);
      if (visible) render();
      schedulePoll();
    }
    catch (error) {
      if (visible) container.replaceChildren(el('div', { class: 'romance-start-panel' }, el('p', { role: 'alert', text: `首页加载失败：${error.message}` }), el('button', { class: 'btn', text: '重试', onclick: load })));
    }
  }
  return { show() { visible = true; if (!busy) load(); else render(); }, hide() { visible = false; clearTimeout(pollTimer); } };
}
