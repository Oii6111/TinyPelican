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
    throw new ApiError((data && data.error) || `请求失败（${res.status}）`, res.status);
  }
  return data;
}

const get = (u) => request('GET', u);
const post = (u, b) => request('POST', u, b);
const del = (u) => request('DELETE', u);

export const api = {
  health: () => get('/api/health'),
  status: () => get('/api/status'),
  unread: { read: () => post('/api/unread/read') },

  contacts: {
    list: () => get('/api/contacts'),
    get: (name) => get('/api/contacts/' + encodeURIComponent(name)),
    save: (name, patch) => post('/api/contacts/' + encodeURIComponent(name), patch),
    setImportant: (name, important) => post('/api/contacts/' + encodeURIComponent(name) + '/important', { important }),
    remove: (name) => del('/api/contacts/' + encodeURIComponent(name)),
    clearMessages: (name) => del('/api/contacts/' + encodeURIComponent(name) + '/messages')
  },
  search: (q) => get('/api/search?q=' + encodeURIComponent(q)),

  intents: {
    list: (status = '') => get('/api/intents' + (status ? '?status=' + encodeURIComponent(status) : '')),
    update: (id, patch) => post('/api/intents/' + encodeURIComponent(id), patch)
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

  chat: {
    conversations: () => get('/api/conversations'),
    create: () => post('/api/conversations'),
    remove: (key) => del('/api/conversations?session=' + encodeURIComponent(key)),
    history: (session) => get('/api/history?session=' + encodeURIComponent(session)),
    send: (message, session) => post('/api/chat', { message, session })
  },

  wechat: {
    status: () => get('/api/wechat/status'),
    loginStart: () => post('/api/wechat/login/start'),
    loginCheck: (session) => get('/api/wechat/login/check?session=' + encodeURIComponent(session)),
    loginConfirm: (session) => post('/api/wechat/login/confirm', { session }),
    logout: () => post('/api/wechat/logout')
  },

  agent: {
    list: (limit = 50) => get('/api/agent/tasks?limit=' + limit),
    create: (task, cwd = '') => post('/api/agent/tasks', { task, cwd: cwd || null }),
    get: (id, afterSeq = 0) => get('/api/agent/tasks/' + encodeURIComponent(id) + (afterSeq ? '?afterSeq=' + afterSeq : '')),
    queue: {
      list: (status = '') => get('/api/agent/queue' + (status ? '?status=' + encodeURIComponent(status) : '')),
      create: (summary, detail = '', type = 'task') => post('/api/agent/queue', { summary, detail, type })
    }
  }
};
