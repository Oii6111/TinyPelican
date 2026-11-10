import { api } from '../api.mjs';
import { el, toast } from '../ui.mjs';

export function mount(container, ctx) {
  let state = { relationships: [], primaryId: '' };
  let contacts = [];
  const render = () => {
    container.replaceChildren(el('div', { class: 'romance-page-head' }, el('div', {}, el('div', { class: 'romance-kicker', text: 'MY RELATIONSHIPS' }), el('h1', { text: '我的关系' }), el('p', { text: '把在意的人放在心上，也把自己的感受放在关系里。' })), el('button', { class: 'btn btn-primary', text: '添加关系', onclick: () => openEditor() })), el('div', { class: 'romance-relations-grid' }, ...(state.relationships.length ? state.relationships.map(card) : [el('div', { class: 'romance-empty romance-empty-large', text: '还没有关系档案，添加一个你想认真了解的人吧。' })])));
  };
  const card = item => el('article', { class: `romance-relation-card ${item.id === state.primaryId ? 'is-primary' : ''}` }, el('div', { class: 'romance-relation-top' }, el('span', { class: 'romance-avatar', text: (item.label || item.contactName).slice(0, 1) }), el('div', {}, el('strong', { text: item.label || item.contactName }), el('span', { text: `${item.type} · ${item.stage}` })), item.id === state.primaryId ? el('span', { class: 'romance-primary-badge', text: '当前关系' }) : null), el('p', { text: item.goal || '还没有写下近期目标' }), el('div', { class: 'romance-relation-actions' }, el('button', { class: 'btn btn-ghost btn-sm', text: item.id === state.primaryId ? '当前主关系' : '设为主关系', disabled: item.id === state.primaryId, onclick: async () => { await api.romance.relationships.setPrimary(item.id); await load(); } }), el('button', { class: 'btn btn-ghost btn-sm', text: '编辑', onclick: () => openEditor(item) })));
  const openEditor = item => {
    const name = el('select', { class: 'select' }, el('option', { value: '', text: '选择已有联系人' }), ...contacts.map(contact => el('option', { value: contact.name, text: contact.remark || contact.name, selected: item?.contactName === contact.name })), el('option', { value: '__new__', text: '＋ 新建联系人' }));
    const newName = el('input', { class: 'input', placeholder: '新联系人姓名', value: '' });
    name.addEventListener('change', () => { newName.hidden = name.value !== '__new__'; });
    newName.hidden = true;
    const label = el('input', { class: 'input', placeholder: '给这段关系一个称呼', value: item?.label || '' });
    const type = el('select', { class: 'select' }, ...['伴侣', '暧昧对象', '正在了解', '朋友'].map(value => el('option', { value, text: value, selected: item?.type === value })));
    const stage = el('select', { class: 'select' }, ...['了解中', '靠近中', '稳定相处', '需要修复'].map(value => el('option', { value, text: value, selected: item?.stage === value })));
    const goal = el('textarea', { class: 'textarea', placeholder: '近期想一起完成什么？', text: item?.goal || '' });
    const mask = el('div', { class: 'romance-modal' }, el('div', { class: 'romance-modal-card' }, el('h2', { text: item ? '编辑关系' : '添加关系' }), field('联系人', name), newName, field('称呼', label), field('关系类型', type), field('阶段', stage), field('近期目标', goal), el('div', { class: 'romance-modal-actions' }, el('button', { class: 'btn btn-ghost', text: '取消', onclick: () => mask.remove() }), el('button', { class: 'btn btn-primary', text: '保存', onclick: async () => { const payload = { contactName: name.value === '__new__' ? '' : name.value, newContactName: name.value === '__new__' ? newName.value : '', label: label.value, type: type.value, stage: stage.value, goal: goal.value }; try { if (item) await api.romance.relationships.update(item.id, payload); else await api.romance.relationships.create(payload); mask.remove(); await load(); toast('关系档案已保存'); } catch (error) { toast(error.message, false); } } }))));
    document.body.append(mask);
  };
  const field = (label, input) => el('label', { class: 'romance-field' }, el('span', { text: label }), input);
  async function load() { try { [state, contacts] = await Promise.all([api.romance.relationships.list(), api.contacts.list()]); render(); } catch (error) { container.replaceChildren(el('div', { class: 'empty', text: error.message })); } }
  load();
  return { show: () => load(), hide() {} };
}
