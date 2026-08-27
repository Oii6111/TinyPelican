import { el, empty, placeholder } from '../ui.mjs';

export function mount(container) {
  empty(container);
  container.className = 'view';
  container.append(
    placeholder('个人知识库', '管理 Agent 可访问的知识文档、笔记、FAQ 与文件，支持上传、分类、全文检索与删除。')
  );
  return { show() {}, hide() {} };
}
