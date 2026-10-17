import { api } from '../api.mjs';
import { el } from '../ui.mjs';

export function memorySettings({ section, field, switchField, createSubTabs }) {
  const input = (placeholder = '') => el('input', { class: 'input', placeholder });
  const select = (choices) => el('select', { class: 'select' }, ...choices.map(([value, text]) => el('option', { value, text })));
  const enabled = el('input', { type: 'checkbox' });
  const provider = select([['searxng', 'SearXNG'], ['moonshot', 'Kimi 内置搜索']]);
  const fallback = select([['', '不使用备用'], ['searxng', 'SearXNG'], ['moonshot', 'Kimi 内置搜索']]);
  const searxng = input('http://localhost:8080');
  const kimiUrl = input('https://api.moonshot.cn/v1');
  const kimiKey = el('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: '留空保留已保存密钥' });
  const kimiModel = input('kimi-k2.6');
  const timeout = el('input', { class: 'input', type: 'number', min: 1, max: 180 });
  const count = el('input', { class: 'input', type: 'number', min: 1, max: 10 });
  const searchMessage = el('span', { class: 'muted', role: 'status' });
  const save = el('button', { class: 'btn btn-primary', text: '保存联网搜索' });
  const test = el('button', { class: 'btn', text: '测试已保存的配置' });
  const searchPanel = section('web-search', '联网搜索', '新鲜话题的内容来源 · SearXNG / Kimi',
    switchField('启用联网搜索', enabled, '只在选择“聊点新鲜的”或测试连接时搜索，不在后台抓取热点。查询仅使用宽泛兴趣词。'),
    field('主服务', provider), field('备用服务', fallback),
    field('SearXNG 地址', searxng, '实例需允许 /search 的 JSON 格式；settings.yml 中 search.formats 加入 json。'),
    field('Kimi API 地址', kimiUrl), field('Kimi API Key', kimiKey), field('Kimi 搜索模型', kimiModel, '模型需支持 $web_search 内置工具。'),
    field('每次请求超时（秒）', timeout), field('最多保留来源数', count),
    el('div', { class: 'field' }, save, ' ', test, ' ', searchMessage));
  save.onclick = async () => {
    save.disabled = true;
    try {
      await api.settings.save({ webSearch: { enabled: enabled.checked, provider: provider.value, fallback: fallback.value, timeoutMs: Number(timeout.value) * 1000, maxResults: Number(count.value), searxng: { baseUrl: searxng.value.trim() }, moonshot: { baseUrl: kimiUrl.value.trim(), model: kimiModel.value.trim(), ...(kimiKey.value.trim() ? { apiKey: kimiKey.value.trim() } : {}) } } });
      kimiKey.value = '';
      searchMessage.textContent = '已保存；核心如正在重启，请稍后测试连接';
    } catch (error) { searchMessage.textContent = error.message; }
    finally { save.disabled = false; }
  };
  test.onclick = async () => {
    test.disabled = true;
    searchMessage.textContent = '正在测试搜索…';
    try { const result = await api.webSearch.test(); searchMessage.textContent = `连接成功 · ${result.results.length} 条来源`; }
    catch (error) { searchMessage.textContent = error.message; }
    finally { test.disabled = false; }
  };
  const auto = el('input', { type: 'checkbox' });
  const days = select([['7', '每 7 天'], ['30', '每 30 天']]);
  const scope = select([['important', '仅特别关心的联系人'], ['all', '所有联系人']]);
  const autoMessage = el('span', { class: 'muted', role: 'status' });
  const autoSave = el('button', { class: 'btn btn-primary', text: '保存画像更新设置', onclick: async () => {
    try { await api.settings.save({ profileAutoUpdate: { enabled: auto.checked, days: Number(days.value), scope: scope.value } }); autoMessage.textContent = '已保存'; }
    catch (error) { autoMessage.textContent = error.message; }
  } });
  // 「联系人」板块：画像与聊天总结属于「联系人」这个上级概念，先放一个子页面；
  // 以后加别的联系人相关设置（例如自动跟进策略）直接加子页面，不用再占导航项。
  const contactTabs = createSubTabs([{ id: 'profile-update', label: '聊天总结与画像更新' }]);
  const autoPanel = section('contacts', '联系人', '画像、聊天总结与适用联系人',
    contactTabs.nav,
    contactTabs.pane('profile-update',
      el('p', { class: 'desc', text: '新增消息入库后排队生成聊天总结，后台逐个联系人处理。画像候选按下列周期生成，始终需要你确认；关闭后仍可在联系人页手动分析。重复导入不触发新任务。' }),
      switchField('自动生成画像候选', auto), field('更新周期', days), field('适用范围', scope),
      el('div', { class: 'field' }, autoSave, ' ', autoMessage)
    )
  );
  return { panels: [searchPanel, autoPanel], load(config) {
    const search = config.webSearch || {};
    enabled.checked = !!search.enabled;
    provider.value = search.provider || 'searxng'; fallback.value = search.fallback || '';
    searxng.value = search.searxng?.baseUrl || '';
    kimiUrl.value = search.moonshot?.baseUrl || 'https://api.moonshot.cn/v1';
    kimiModel.value = search.moonshot?.model || 'kimi-k2.6';
    kimiKey.value = ''; kimiKey.placeholder = search.moonshot?.apiKey ? '已保存密钥；留空保留' : '填写 API Key';
    timeout.value = (search.timeoutMs || 45000) / 1000; count.value = search.maxResults || 6;
    auto.checked = !!config.profileAutoUpdate?.enabled; days.value = String(config.profileAutoUpdate?.days || 7); scope.value = config.profileAutoUpdate?.scope || 'important';
  } };
}
