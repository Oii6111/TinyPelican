// 小鹈鹕 Electron 预加载：向浮窗渲染进程暴露最小 IPC 桥
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('suggestionsBridge', {
  showCard: () => ipcRenderer.send('suggestion:show-card'),
  hideCard: () => ipcRenderer.send('suggestion:hide-card'),
  applyDone: () => ipcRenderer.send('suggestion:apply-done')
});
