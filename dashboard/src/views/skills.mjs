import { el, empty, placeholder } from '../ui.mjs';

export function mount(container) {
  empty(container);
  container.className = 'view';
  container.append(
    placeholder('Skill 管理', '以卡片方式管理技能：查看提示词、关联工具、使用次数与成功率，支持创建/编辑技能。')
  );
  return { show() {}, hide() {} };
}
