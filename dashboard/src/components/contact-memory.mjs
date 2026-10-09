import { api } from '../api.mjs';
import { el, fmtTime, toast } from '../ui.mjs';

export function memoryPanel(contact) {
  const summary = el('div', { class: 'wechat-profile-meta' });
  const state = el('div', { class: 'hint contact-memory-state', role: 'status' });
  const rebuild = el('button', { class: 'btn btn-block', text: '立即生成 / 重建总结' });
  const analyze = el('button', { class: 'btn btn-block contact-profile-analyze', text: '分析完整历史生成画像' });
  const panel = el('details', { class: 'wechat-profile-section' }, el('summary', { text: '聊天话题总结' }), summary);
  let stopped = false;
  let timer;
  let announced = '';
  async function refresh() {
    if (stopped) return;
    try {
      const data = await api.contacts.summary(contact.name);
      if (stopped) return;
      const saved = data.chatSummary || {};
      const summaryNodes = [el('p', { text: saved.summary || '尚未生成总结' }),
        ...(saved.topics || []).map((topic) => {
          const separator = topic.indexOf('｜');
          return separator > 0
            ? el('div', { class: 'chat-topic-entry' }, el('strong', { class: 'chat-topic-time', text: topic.slice(0, separator) }), el('div', { text: topic.slice(separator + 1) }))
            : el('div', { class: 'chat-topic-entry', text: topic });
        }),
        saved.updatedAt ? el('small', { text: `覆盖 ${saved.messageCount || 0} 条 · ${fmtTime(saved.from)} 至 ${fmtTime(saved.to)} · 更新于 ${fmtTime(saved.updatedAt)}` }) : null];
      summary.replaceChildren(...summaryNodes.filter(Boolean));
      const summaryJob = data.jobs.find((job) => job.kind === 'summary');
      const profileJob = data.jobs.find((job) => job.kind === 'profile');
      const active = (job) => job && ['pending', 'running'].includes(job.status);
      rebuild.disabled = !!active(summaryJob); rebuild.textContent = active(summaryJob) ? '总结生成中…' : '立即生成 / 重建总结';
      analyze.disabled = !!active(profileJob); analyze.textContent = active(profileJob) ? '画像生成中…' : '分析完整历史生成画像';
      state.textContent = data.jobs.map((job) => `${job.kind === 'summary' ? '总结' : '画像'}：${{ pending: '排队中', running: '生成中', idle: job.intentId ? '候选已加入待确认' : '处理完成', failed: '失败，可点击重试' }[job.status] || job.status}${job.remaining ? ` · 待处理 ${job.remaining} 条` : ''}${job.error ? ' · ' + job.error : ''}`).join('\n');
      if (profileJob?.intentId && announced && announced !== profileJob.intentId) toast('画像候选已加入待确认列表');
      announced = profileJob?.intentId || 'loaded';
    } catch (error) { state.textContent = error.message; }
    finally { if (!stopped) timer = setTimeout(refresh, 2500); }
  }
  rebuild.onclick = async () => {
    rebuild.disabled = true; rebuild.textContent = '正在排队…';
    try { await api.contacts.rebuildSummary(contact.name); clearTimeout(timer); refresh(); }
    catch (error) { rebuild.disabled = false; rebuild.textContent = '立即生成 / 重建总结'; toast(error.message, false); }
  };
  analyze.onclick = async () => {
    analyze.disabled = true; analyze.textContent = '画像生成中…';
    try { await api.contacts.analyzeProfile(contact.name); clearTimeout(timer); refresh(); }
    catch (error) { analyze.disabled = false; analyze.textContent = '分析完整历史生成画像'; toast(error.message, false); }
  };
  refresh();
  return { panel, rebuild, analyze, state, stop() { stopped = true; clearTimeout(timer); } };
}
