import { api } from '../api.mjs';
import { el } from '../ui.mjs';

export function formatMediaSize(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function localMediaUrl(value, download = false) {
  const pattern = download ? /^\/api\/wechat\/media\/[a-zA-Z0-9_-]+(?:\?download=1)?$/ : /^\/api\/wechat\/media\/[a-zA-Z0-9_-]+$/;
  return typeof value === 'string' && pattern.test(value) ? value : '';
}

export function renderWeixinAttachments(attachments) {
  const list = el('div', { class: 'weixin-attachments' });
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (!attachment || typeof attachment !== 'object') continue;
    const name = String(attachment.name || (attachment.kind === 'image' ? '图片' : '文件'));
    const card = el('div', { class: 'weixin-attachment' });
    card.append(el('strong', { text: name }), el('span', { class: 'muted', text: formatMediaSize(attachment.size) }));
    const previewUrl = localMediaUrl(attachment.url);
    const downloadUrl = localMediaUrl(attachment.downloadUrl, true);
    if (attachment.status === 'failed') {
      card.append(el('span', { class: 'weixin-media-status error', text: attachment.error || '附件接收失败，请重新发送' }));
    } else if (attachment.status === 'ready' && (previewUrl || downloadUrl)) {
      if (attachment.kind === 'image' && previewUrl) {
        card.prepend(el('a', { href: previewUrl, target: '_blank', rel: 'noopener noreferrer', title: '查看原图' },
          el('img', { class: 'weixin-image-preview', src: previewUrl, alt: name, loading: 'lazy', onerror: (event) => {
            event.target.hidden = true;
            card.append(el('span', { class: 'weixin-media-status error', text: '图片预览失败，可下载查看' }));
          } })
        ));
      }
      card.append(el('a', { class: 'weixin-media-download', href: downloadUrl || previewUrl + '?download=1', download: name, text: '下载' }));
    } else {
      card.append(el('span', { class: 'weixin-media-status', text: '附件暂不可用' }));
    }
    list.append(card);
  }
  return list;
}

export function createWeixinMediaSender(status = {}) {
  const maxBytes = Math.min(Number(status.media?.maxBytes) || 104857600, 104857600);
  const configured = !!status.configured;
  const input = el('input', { type: 'file', hidden: true });
  const imageButton = el('button', { class: 'btn btn-sm', text: '选择图片', disabled: !configured || status.media?.images === false });
  const fileButton = el('button', { class: 'btn btn-sm', text: '选择文件', disabled: !configured || status.media?.files === false });
  const removeButton = el('button', { class: 'btn btn-ghost btn-sm', text: '移除', disabled: true });
  const sendButton = el('button', { class: 'btn btn-primary btn-sm', text: '发送到我的微信', disabled: true });
  const selected = el('div', { class: 'weixin-media-selected muted', text: '尚未选择图片或文件' });
  const note = el('textarea', { class: 'input', rows: 2, placeholder: '附带说明（可选）', disabled: !configured });
  const feedback = el('div', { class: 'weixin-media-status', role: 'status', 'aria-live': 'polite' });
  const preview = el('div');
  const panel = el('div', { class: 'weixin-media-sender' },
    el('div', { class: 'hint', text: `图片和文件会发送到扫码绑定的微信。每次最多 ${formatMediaSize(maxBytes)}；选择后点击发送。` }),
    input, el('div', { class: 'row' }, imageButton, fileButton, removeButton), selected, preview, note,
    el('div', { class: 'row' }, sendButton), feedback
  );
  let file = null;
  let uploaded = null;
  let sending = false;

  function updateControls() {
    input.disabled = sending;
    imageButton.disabled = sending || !configured || status.media?.images === false;
    fileButton.disabled = sending || !configured || status.media?.files === false;
    removeButton.disabled = sending || !file;
    sendButton.disabled = sending || !file || !configured;
    note.disabled = sending || !configured;
  }

  function reset() {
    file = null;
    uploaded = null;
    input.value = '';
    selected.textContent = '尚未选择图片或文件';
    preview.replaceChildren();
    updateControls();
  }

  imageButton.onclick = () => { input.accept = 'image/png,image/jpeg,image/gif,image/webp'; input.click(); };
  fileButton.onclick = () => { input.accept = ''; input.click(); };
  removeButton.onclick = () => { reset(); feedback.textContent = ''; };
  input.addEventListener('change', () => {
    if (sending) return;
    const nextFile = input.files?.[0];
    if (!nextFile) return;
    if (!nextFile.size || nextFile.size > maxBytes) {
      reset();
      feedback.className = 'weixin-media-status error';
      feedback.textContent = nextFile.size ? `文件不能超过 ${formatMediaSize(maxBytes)}` : '不能发送空文件';
      return;
    }
    file = nextFile;
    uploaded = null;
    preview.replaceChildren();
    selected.textContent = `${file.name} · ${formatMediaSize(file.size)}`;
    feedback.textContent = '';
    updateControls();
  });
  sendButton.onclick = async () => {
    if (!file || sending || !configured) return;
    sending = true;
    updateControls();
    feedback.className = 'weixin-media-status';
    try {
      if (!uploaded) {
        sendButton.textContent = '上传中…';
        feedback.textContent = '正在上传附件…';
        uploaded = (await api.wechat.upload(file)).attachment;
        preview.replaceChildren(renderWeixinAttachments([uploaded]));
      }
      sendButton.textContent = '发送中…';
      feedback.textContent = '正在发送到微信…';
      const result = await api.wechat.send(uploaded.id, note.value.trim());
      if (!result?.ok) {
        const error = new Error(result?.error || '发送失败，请重试');
        error.textSent = result?.textSent === true;
        throw error;
      }
      reset();
      note.value = '';
      feedback.textContent = '已发送到微信，可在对话中查看。';
    } catch (error) {
      if (error.textSent) note.value = '';
      feedback.className = 'weixin-media-status error';
      feedback.textContent = `发送失败：${error.message}。${error.textSent ? '说明文字已发送，重试仅发送附件。' : '已保留附件，可重试。'}`;
    } finally {
      sending = false;
      sendButton.textContent = '发送到我的微信';
      updateControls();
    }
  };
  return panel;
}
