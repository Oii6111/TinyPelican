// 看板 API 客户端（对应参考项目的 services 层）

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    // 会话失效（例如核心重启后 token 失效）：回登录页重新登录，别让看板停在“半死”状态
    if (res.status === 401) {
      const p = location.pathname;
      if (p === '/' || p === '/index.html') location.href = '/login';
    }
    const error = new ApiError((data && data.error) || `请求失败（${res.status}）`, res.status);
    if (data?.textSent === true) error.textSent = true;
    throw error;
  }
  return data;
}

const get = (u) => request('GET', u);
const post = (u, b) => request('POST', u, b);
const del = (u) => request('DELETE', u);

async function uploadWechatMedia(file) {
  if (!file || !Number.isFinite(file.size) || file.size <= 0) throw new ApiError('请选择非空图片或文件', 400);
  if (file.size > 104857600) throw new ApiError('文件大小不能超过 100 MB', 413);
  const res = await fetch('/api/wechat/media', {
    method: 'POST',
    headers: { 'X-Filename': encodeURIComponent(file.name || 'attachment'), 'Content-Type': file.type || 'application/octet-stream' },
    body: file
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok || !data?.ok || !data.attachment?.id) throw new ApiError(data?.error || '附件上传失败，请重试', res.status);
  return data;
}

export const api = {
  health: () => get('/api/health'),
  status: () => get('/api/status'),
  unread: { read: () => post('/api/unread/read') },

  contacts: {
    template: () => get('/api/profile-template'),
    summary: (name) => get('/api/contacts/' + encodeURIComponent(name) + '/chat-summary'),
    rebuildSummary: (name) => post('/api/contacts/' + encodeURIComponent(name) + '/chat-summary/rebuild', {}),
    list: () => get('/api/contacts'),
    get: (name) => get('/api/contacts/' + encodeURIComponent(name)),
    messages: (name, q = '', limit = 200, before = '', beforeId = 0) => get('/api/contacts/' + encodeURIComponent(name) + '/messages?q=' + encodeURIComponent(q) + '&limit=' + limit + '&before=' + encodeURIComponent(before) + '&beforeId=' + beforeId),
    archiveMessages: (name, before = '', limit = 100, beforeId = 0) => get('/api/contacts/' + encodeURIComponent(name) + '/messages?archive=1&before=' + encodeURIComponent(before) + '&limit=' + limit + '&beforeId=' + beforeId),
    analyzeProfile: (name) => post('/api/contacts/' + encodeURIComponent(name) + '/analyze-profile', {}),
    profile: (name) => get('/api/contacts/' + encodeURIComponent(name) + '/profile'),
    saveProfile: (name, patch) => post('/api/contacts/' + encodeURIComponent(name) + '/profile', patch),
    save: (name, patch) => post('/api/contacts/' + encodeURIComponent(name), patch),
    emails: (name) => get('/api/contacts/' + encodeURIComponent(name) + '/emails'),
    linkEmail: (name, address) => post('/api/contacts/' + encodeURIComponent(name) + '/email-links', { address }),
    unlinkEmail: (name, address) => del('/api/contacts/' + encodeURIComponent(name) + '/email-links/' + encodeURIComponent(address)),
    setImportant: (name, important) => post('/api/contacts/' + encodeURIComponent(name) + '/important', { important }),
    remove: (name) => del('/api/contacts/' + encodeURIComponent(name)),
    clearMessages: (name) => del('/api/contacts/' + encodeURIComponent(name) + '/messages')
  },
  search: (q) => get('/api/search?q=' + encodeURIComponent(q)),

  intents: {
    list: (status = '') => get('/api/intents' + (status ? '?status=' + encodeURIComponent(status) : '')),
    update: (id, patch) => post('/api/intents/' + encodeURIComponent(id), patch),
    confirm: (id) => post('/api/intents/' + encodeURIComponent(id) + '/confirm')
  },

  schedules: {
    list: (status = '') => get('/api/schedules' + (status ? '?status=' + encodeURIComponent(status) : '')),
    create: (schedule) => post('/api/schedules', schedule),
    update: (id, patch) => post('/api/schedules/' + encodeURIComponent(id), patch),
    remove: (id) => del('/api/schedules/' + encodeURIComponent(id))
  },

  tasks: {
    list: (status = '') => get('/api/tasks' + (status ? '?status=' + encodeURIComponent(status) : '')),
    create: (task) => post('/api/tasks', task),
    update: (id, patch) => post('/api/tasks/' + encodeURIComponent(id), patch),
    start: (id) => post('/api/tasks/' + encodeURIComponent(id) + '/start'),
    complete: (id) => post('/api/tasks/' + encodeURIComponent(id) + '/complete'),
    remove: (id) => del('/api/tasks/' + encodeURIComponent(id))
  },

  voice: {
    list: () => get('/api/voice-pending'),
    skip: (index) => del('/api/voice-pending?index=' + index)
  },

  logs: {
    list: (limit = 300) => get('/api/logs?limit=' + limit)
  },

  settings: {
    get: () => get('/api/settings'),
    save: (patch) => post('/api/settings', patch)
  },

  engine: {
    test: (engine) => post('/api/engine/test', { engine })
  },
  webSearch: {
    status: () => get('/api/web-search/status'),
    test: () => post('/api/web-search/test', {})
  },

  email: {
    status: () => get('/api/email/status'),
    test: (config) => post('/api/email/test', config || {}),
    sync: () => post('/api/email/sync', {}),
    messages: (params = {}) => {
      const q = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') q.set(key, value);
      }
      const suffix = q.toString();
      return get('/api/email/messages' + (suffix ? '?' + suffix : ''));
    },
    message: (id) => get('/api/email/messages/' + encodeURIComponent(id)),
    draft: (draft) => post('/api/email/drafts', draft),
    send: (message) => post('/api/email/send', message)
  },

  notify: {
    test: () => post('/api/notify/test')
  },

  chat: {
    conversations: () => get('/api/conversations'),
    create: () => post('/api/conversations'),
    remove: (key) => del('/api/conversations?session=' + encodeURIComponent(key)),
    history: (session) => get('/api/history?session=' + encodeURIComponent(session)),
    send: (message, session, contact = '') => post('/api/chat', { message, session, ...(contact ? { contact } : {}) })
  },

  wechat: {
    status: () => get('/api/wechat/status'),
    upload: (file) => uploadWechatMedia(file),
    send: (attachmentId, text = '') => post('/api/wechat/send', { attachmentId, ...(text ? { text } : {}) }),
    loginStart: () => post('/api/wechat/login/start'),
    loginCheck: (session) => get('/api/wechat/login/check?session=' + encodeURIComponent(session)),
    loginConfirm: (session) => post('/api/wechat/login/confirm', { session }),
    logout: () => post('/api/wechat/logout')
  },

  replySuggestions: {
    current: () => get('/api/reply-suggestions/current'),
    newTopic: (direction = 'history', deep = false) => post('/api/reply-suggestions/current/new-topic', { direction, deep }),
    regenerate: (hint = '', rotate = false, deep = false) => post('/api/reply-suggestions/current/regenerate', { hint, rotate, deep }),
    continuePlan: (id, deep = false) => post('/api/reply-suggestions/' + encodeURIComponent(id) + '/continue', { deep }),
    apply: (id, plan) => post('/api/reply-suggestions/' + encodeURIComponent(id) + '/apply', { plan }),
    next: (id) => post('/api/reply-suggestions/' + encodeURIComponent(id) + '/next'),
    reset: (id) => post('/api/reply-suggestions/' + encodeURIComponent(id) + '/reset')
  },

  agent: {
    webui: () => post('/api/agent/webui'),
    list: (limit = 50) => get('/api/agent/tasks?limit=' + limit),
    create: (task, cwd = '') => post('/api/agent/tasks', { task, cwd: cwd || null }),
    get: (id, afterSeq = 0) => get('/api/agent/tasks/' + encodeURIComponent(id) + (afterSeq ? '?afterSeq=' + afterSeq : '')),
    queue: {
      list: (status = '') => get('/api/agent/queue' + (status ? '?status=' + encodeURIComponent(status) : '')),
      create: (summary, detail = '', type = 'task') => post('/api/agent/queue', { summary, detail, type })
    }
  }
};
