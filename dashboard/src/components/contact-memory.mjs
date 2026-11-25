import { api } from '../api.mjs';
import { el, fmtTime, toast } from '../ui.mjs';
import { contactIcon, setContactButton } from './contact-visuals.mjs';

// 侧栏默认只展示几条话题，其余收进「查看全部」弹窗，避免画像侧栏被长列表撑开
const PREVIEW_TOPICS = 3;
// 弹窗每页展示的话题条数
const PAGE_SIZE = 8;

function topicNode(topic) {
  const text = String(topic ?? '');
  const separator = text.indexOf('｜');
  return separator > 0
    ? el('div', { class: 'chat-topic-entry' }, el('strong', { class: 'chat-topic-time', text: text.slice(0, separator) }), el('div', { text: text.slice(separator + 1) }))
    : el('span', { class: 'contact-topic-chip', text });
}

export function memoryPanel(contact, { collapsed: initialCollapsed = false, onCollapseChange = () => {} } = {}) {
  const summary = el('div', { class: 'contact-summary-content' });
  const body = el('div', { id: 'contact-summary-body', class: 'contact-summary-body' }, summary);
  const state = el('div', { class: 'hint contact-memory-state', role: 'status', 'aria-live': 'polite' });
  const rebuild = el('button', { class: 'btn btn-block', 'aria-label': '更新聊天总结' });
  const analyze = el('button', { class: 'btn btn-block contact-profile-analyze', 'aria-label': '更新联系人画像' });
  const refreshButton = el('button', { class: 'contact-card-refresh', title: '更新聊天总结', 'aria-label': '更新聊天总结' }, contactIcon('refresh'));
  const collapse = el('button', { class: 'contact-card-collapse', 'aria-label': '收起聊天话题总结', 'aria-expanded': 'true', 'aria-controls': 'contact-summary-body' }, contactIcon('chevron'));
  const summaryStatus = el('span', { class: 'contact-status', text: '加载中' });
  const profileStatus = el('span', { class: 'contact-status', text: '加载中' });
  const profileEmptyTitle = el('strong', { text: '暂无画像信息' });
  const profileEmptyDescription = el('span', { text: '可手动编辑，或分析聊天记录生成画像' });
  const profileEmpty = el('div', { class: 'contact-profile-empty' }, profileEmptyTitle, profileEmptyDescription);
  const panel = el('section', { class: 'wechat-profile-card contact-summary-card' },
    el('div', { class: 'contact-card-head' }, el('h3', { text: '聊天话题总结' }), el('div', { class: 'contact-card-tools' }, collapse, refreshButton, summaryStatus)), body
  );
  let collapsed = false;
  // 与「具体画像」同一套折叠行为：只留标题行，内容整体收起
  function setCollapsed(value) {
    collapsed = value;
    body.hidden = value;
    panel.classList.toggle('collapsed', value);
    collapse.classList.toggle('collapsed', value);
    collapse.setAttribute('aria-expanded', String(!value));
    collapse.setAttribute('aria-label', value ? '展开聊天话题总结' : '收起聊天话题总结');
    collapse.setAttribute('title', value ? '展开聊天话题总结' : '收起聊天话题总结');
    onCollapseChange(value);
  }
  collapse.onclick = () => setCollapsed(!collapsed);
  setCollapsed(!!initialCollapsed);
  setContactButton(rebuild, 'refresh', '更新分析');
  setContactButton(analyze, 'profile', '更新联系人画像');
  let stopped = false;
  let timer;
  let announced = '';
  let latest = contact.chatSummary || {};
  let renderedKey = '';
  let dialog = null;
  let dialogCleanup = null;

  function updateStatus(badge, text, tone = '') {
    badge.textContent = text;
    badge.className = 'contact-status' + (tone ? ' ' + tone : '');
  }

  function topicsOf(saved) {
    return Array.isArray(saved?.topics) ? saved.topics.filter((topic) => typeof topic === 'string' && topic.trim()) : [];
  }

  function closeTopicDialog() {
    if (typeof dialogCleanup === 'function') dialogCleanup();
    dialogCleanup = null;
    const mask = dialog;
    dialog = null;
    if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
    else mask?.remove?.();
  }

  function openTopicDialog() {
    closeTopicDialog();
    let items = topicsOf(latest);
    let page = 0;
    const totalPages = () => Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    const list = el('div', { class: 'contact-topic-modal-list' });
    const pager = el('div', { class: 'contact-topic-pager' });
    const summaryText = el('p', { class: 'contact-summary-text', text: latest.summary || '尚未生成聊天总结，点击更新分析开始生成。' });
    const rangeText = el('small', { class: 'contact-summary-range' });
    const dialogState = el('div', { class: 'hint contact-topic-modal-state', role: 'status', 'aria-live': 'polite', text: '正在加载全部话题总结…' });
    let loading = true;

    function syncRange(saved) {
      rangeText.textContent = saved?.updatedAt
        ? `覆盖 ${saved.messageCount || 0} 条 · ${fmtTime(saved.from)} 至 ${fmtTime(saved.to)} · 更新于 ${fmtTime(saved.updatedAt)}`
        : '';
      rangeText.hidden = !rangeText.textContent;
    }

    // 分页只在弹窗内进行：侧栏不渲染完整列表，切换页码不额外请求服务端
    function renderPage() {
      if (loading) return;
      page = Math.min(Math.max(page, 0), totalPages() - 1);
      const slice = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      list.replaceChildren(...(slice.length ? slice.map(topicNode) : [el('div', { class: 'contact-topic-empty', text: '暂无话题总结' })]));
      pager.replaceChildren(
        el('span', { class: 'contact-topic-page', text: items.length ? `第 ${page + 1} / ${totalPages()} 页 · 共 ${items.length} 条` : '共 0 条' }),
        el('div', { class: 'contact-topic-page-actions' },
          el('button', { class: 'btn btn-ghost btn-sm contact-topic-prev', type: 'button', 'aria-label': '上一页', text: '上一页', disabled: page <= 0, onclick: () => { page -= 1; renderPage(); } }),
          el('button', { class: 'btn btn-ghost btn-sm contact-topic-next', type: 'button', 'aria-label': '下一页', text: '下一页', disabled: page >= totalPages() - 1, onclick: () => { page += 1; renderPage(); } })
        )
      );
    }

    const closeButton = el('button', { class: 'wechat-close-btn', type: 'button', 'aria-label': '关闭全部聊天话题', title: '关闭', onclick: closeTopicDialog }, contactIcon('close'));
    const mask = el('div', { class: 'modal-mask' },
      el('div', { class: 'modal contact-topic-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'contact-topic-modal-title' },
        el('header', { class: 'contact-topic-modal-head' },
          el('div', { class: 'contact-topic-modal-title' },
            el('h3', { id: 'contact-topic-modal-title', text: '全部聊天话题总结' }),
            el('span', { class: 'contact-topic-modal-sub', text: `${contact.remark || contact.name} · 基于聊天记录生成` })
          ),
          closeButton
        ),
        summaryText,
        dialogState,
        list,
        rangeText,
        pager
      )
    );
    mask.onclick = (event) => { if (event && event.target === mask) closeTopicDialog(); };
    list.replaceChildren(el('div', { class: 'contact-topic-empty', text: '正在加载…' }));
    document.body.append(mask);
    dialog = mask;
    if (typeof document.addEventListener === 'function') {
      const onKeyDown = (event) => { if (event?.key === 'Escape') closeTopicDialog(); };
      document.addEventListener('keydown', onKeyDown);
      dialogCleanup = () => document.removeEventListener('keydown', onKeyDown);
    }
    syncRange(latest);

    // 打开弹窗时才拉取完整总结，避免侧栏轮询承担全量数据
    api.contacts.summary(contact.name).then((data) => {
      if (dialog !== mask) return;
      const saved = data?.chatSummary || {};
      const full = topicsOf(saved);
      summaryText.textContent = saved.summary || '尚未生成聊天总结，点击更新分析开始生成。';
      syncRange(saved);
      if (full.length) items = full;
      loading = false;
      page = 0;
      dialogState.textContent = full.length ? '' : (items.length ? '' : '暂无话题总结');
      renderPage();
    }).catch((error) => {
      if (dialog !== mask) return;
      loading = false;
      page = 0;
      dialogState.textContent = `全部话题加载失败，当前显示已缓存的 ${items.length} 条：${error.message}`;
      renderPage();
    });
  }

  function renderSummary(saved) {
    latest = saved || {};
    const key = JSON.stringify([latest.summary || '', latest.topics || [], latest.updatedAt || '', latest.messageCount || 0]);
    // 服务端状态轮询频繁，内容没变就不重建，避免「查看全部」按钮在点击前被替换
    if (key === renderedKey) return;
    renderedKey = key;
    const topics = topicsOf(latest);
    const summaryNodes = [el('p', { class: latest.summary ? 'contact-summary-text' : 'contact-summary-empty', text: latest.summary || '尚未生成聊天总结，点击更新分析开始生成。' }),
      el('div', { class: 'contact-topic-list' }, ...topics.slice(0, PREVIEW_TOPICS).map(topicNode)),
      topics.length > PREVIEW_TOPICS
        ? el('button', { class: 'contact-summary-more', type: 'button', 'aria-label': '查看全部聊天话题', onclick: openTopicDialog },
          el('span', { text: '查看全部' }), el('small', { text: `共 ${topics.length} 条` }))
        : null,
      latest.updatedAt ? el('small', { class: 'contact-summary-range', text: `覆盖 ${latest.messageCount || 0} 条 · ${fmtTime(latest.from)} 至 ${fmtTime(latest.to)} · 更新于 ${fmtTime(latest.updatedAt)}` }) : null];
    summary.replaceChildren(...summaryNodes.filter(Boolean));
  }
  renderSummary(contact.chatSummary || {});
  async function refresh() {
    if (stopped) return;
    try {
      const data = await api.contacts.summary(contact.name);
      if (stopped) return;
      const saved = data.chatSummary || {};
      renderSummary(saved);
      const jobs = data.jobs || [];
      const summaryJob = jobs.find((job) => job.kind === 'summary');
      const profileJob = jobs.find((job) => job.kind === 'profile');
      const active = (job) => job && ['pending', 'running'].includes(job.status);
      rebuild.disabled = refreshButton.disabled = !!active(summaryJob);
      analyze.disabled = !!active(profileJob);
      setContactButton(rebuild, 'refresh', active(summaryJob) ? '总结生成中…' : '更新分析');
      setContactButton(analyze, 'profile', active(profileJob) ? '画像生成中…' : '更新联系人画像');
      updateStatus(summaryStatus, summaryJob?.status === 'failed' ? '失败' : active(summaryJob) ? '生成中' : saved.summary ? '已完成' : '未生成', summaryJob?.status === 'failed' ? 'error' : active(summaryJob) ? 'pending' : saved.summary ? 'complete' : '');
      const hasProfile = Object.values(contact.profile || {}).some((section) => typeof section === 'object' && section !== null ? Object.values(section).some(Boolean) : !!section);
      updateStatus(profileStatus, profileJob?.status === 'failed' ? '失败' : active(profileJob) ? '生成中' : profileJob?.intentId ? '待确认' : hasProfile ? '已保存' : '未生成', profileJob?.status === 'failed' ? 'error' : active(profileJob) || profileJob?.intentId ? 'pending' : hasProfile ? 'complete' : '');
      profileEmptyTitle.textContent = active(profileJob) ? '正在分析聊天记录' : profileJob?.intentId ? '画像候选已生成' : '暂无画像信息';
      profileEmptyDescription.textContent = active(profileJob) ? '生成完成后可在待确认列表中查看' : profileJob?.intentId ? '请前往待确认列表审核，或手动编辑画像' : '可手动编辑，或分析聊天记录生成画像';
      state.textContent = jobs.filter((job) => active(job) || job.status === 'failed' || job.intentId).map((job) => `${job.kind === 'summary' ? '总结' : '画像'}：${{ pending: job.error ? '已暂停' : '排队中', running: '生成中', idle: job.intentId ? '候选已加入待确认' : '处理完成', failed: '失败，可点击重试' }[job.status] || job.status}${job.remaining ? ` · 待处理 ${job.remaining} 条` : ''}${job.error ? ' · ' + job.error : ''}`).join('\n');
      if (profileJob?.intentId && announced && announced !== profileJob.intentId) toast('画像候选已加入待确认列表');
      announced = profileJob?.intentId || 'loaded';
    } catch (error) { if (!stopped) { state.textContent = '分析状态加载失败：' + error.message; updateStatus(summaryStatus, '暂不可用', 'error'); updateStatus(profileStatus, '暂不可用', 'error'); } }
    finally { if (!stopped) timer = setTimeout(refresh, 2500); }
  }
  rebuild.onclick = async () => {
    rebuild.disabled = refreshButton.disabled = true;
    setContactButton(rebuild, 'refresh', '正在排队…');
    try { await api.contacts.rebuildSummary(contact.name); clearTimeout(timer); await refresh(); }
    catch (error) { rebuild.disabled = refreshButton.disabled = false; setContactButton(rebuild, 'refresh', '更新分析'); toast(error.message, false); }
  };
  refreshButton.onclick = () => rebuild.click();
  analyze.onclick = async () => {
    analyze.disabled = true; setContactButton(analyze, 'profile', '画像生成中…');
    try { await api.contacts.analyzeProfile(contact.name); clearTimeout(timer); await refresh(); }
    catch (error) { analyze.disabled = false; setContactButton(analyze, 'profile', '更新联系人画像'); toast(error.message, false); }
  };
  refresh();
  return { panel, body, collapse, rebuild, analyze, state, profileStatus, profileEmpty, stop() { stopped = true; clearTimeout(timer); closeTopicDialog(); } };
}
