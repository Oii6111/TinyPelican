import { api } from '../api.mjs';
import { el, fmtTime, toast } from '../ui.mjs';
import { contactIcon, setContactButton } from './contact-visuals.mjs';

export function memoryPanel(contact) {
  const summary = el('div', { class: 'contact-summary-content' });
  const state = el('div', { class: 'hint contact-memory-state', role: 'status', 'aria-live': 'polite' });
  const rebuild = el('button', { class: 'btn btn-block', 'aria-label': '更新聊天总结' });
  const analyze = el('button', { class: 'btn btn-block contact-profile-analyze', 'aria-label': '更新联系人画像' });
  const refreshButton = el('button', { class: 'contact-card-refresh', title: '更新聊天总结', 'aria-label': '更新聊天总结' }, contactIcon('refresh'));
  const summaryStatus = el('span', { class: 'contact-status', text: '加载中' });
  const profileStatus = el('span', { class: 'contact-status', text: '加载中' });
  const profileEmptyTitle = el('strong', { text: '暂无画像信息' });
  const profileEmptyDescription = el('span', { text: '可手动编辑，或分析聊天记录生成画像' });
  const profileEmpty = el('div', { class: 'contact-profile-empty' }, profileEmptyTitle, profileEmptyDescription);
  const panel = el('section', { class: 'wechat-profile-card contact-summary-card' },
    el('div', { class: 'contact-card-head' }, el('h3', { text: '聊天话题总结' }), el('div', { class: 'contact-card-tools' }, refreshButton, summaryStatus)), summary
  );
  setContactButton(rebuild, 'refresh', '更新分析');
  setContactButton(analyze, 'profile', '更新联系人画像');
  let stopped = false;
  let timer;
  let announced = '';
  function updateStatus(badge, text, tone = '') {
    badge.textContent = text;
    badge.className = 'contact-status' + (tone ? ' ' + tone : '');
  }
  function renderSummary(saved) {
    const summaryNodes = [el('p', { class: saved.summary ? 'contact-summary-text' : 'contact-summary-empty', text: saved.summary || '尚未生成聊天总结，点击更新分析开始生成。' }),
      el('div', { class: 'contact-topic-list' }, ...(saved.topics || []).map((topic) => {
        const separator = topic.indexOf('｜');
        return separator > 0
          ? el('div', { class: 'chat-topic-entry' }, el('strong', { class: 'chat-topic-time', text: topic.slice(0, separator) }), el('div', { text: topic.slice(separator + 1) }))
          : el('span', { class: 'contact-topic-chip', text: topic });
      })),
      saved.updatedAt ? el('small', { class: 'contact-summary-range', text: `覆盖 ${saved.messageCount || 0} 条 · ${fmtTime(saved.from)} 至 ${fmtTime(saved.to)} · 更新于 ${fmtTime(saved.updatedAt)}` }) : null];
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
      state.textContent = jobs.filter((job) => active(job) || job.status === 'failed' || job.intentId).map((job) => `${job.kind === 'summary' ? '总结' : '画像'}：${{ pending: '排队中', running: '生成中', idle: job.intentId ? '候选已加入待确认' : '处理完成', failed: '失败，可点击重试' }[job.status] || job.status}${job.remaining ? ` · 待处理 ${job.remaining} 条` : ''}${job.error ? ' · ' + job.error : ''}`).join('\n');
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
  return { panel, rebuild, analyze, state, profileStatus, profileEmpty, stop() { stopped = true; clearTimeout(timer); } };
}
