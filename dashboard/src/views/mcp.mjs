import { el, empty, placeholder } from '../ui.mjs';

export function mount(container) {
  empty(container);
  container.className = 'view';
  container.append(
    placeholder('MCP 工具管理', '管理已注册的 MCP 服务器与工具：查看工具 schema、测试调用、添加/删除服务器配置。')
  );
  return { show() {}, hide() {} };
}
