// 小鹈鹕 Electron 预加载：向浮窗渲染进程暴露最小 IPC 桥
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('suggestionsBridge', {
  // 卡片内容变化时把窗口调整到刚好包住卡片，避免透明区域挡住微信点击。
  resize: (width, height) => ipcRenderer.send('suggestion:resize', { width, height }),
  hideCard: () => ipcRenderer.send('suggestion:hide-card'),
  // 主进程把浮窗显示出来时通知卡片立刻刷新（显示「思考中」或新一批建议）
  onShown: (cb) => ipcRenderer.on('suggestion:shown', () => cb())
});
