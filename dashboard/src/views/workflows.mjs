import { el, empty, placeholder } from '../ui.mjs';

export function mount(container) {
  empty(container);
  container.className = 'view';
  container.append(
    placeholder('Workflow', '可视化工作流编辑器：拖拽触发器、条件、工具调用、LLM 推理、消息推送、记忆操作节点并连接成流程。')
  );
  return { show() {}, hide() {} };
}
