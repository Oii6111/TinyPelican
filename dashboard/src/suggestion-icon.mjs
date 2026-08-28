// 回复建议小图标：点击后通知 Electron 主进程弹出建议卡片
const icon = document.getElementById('icon');
if (icon) {
  icon.addEventListener('click', () => {
    if (window.suggestionsBridge && window.suggestionsBridge.showCard) {
      window.suggestionsBridge.showCard();
    }
  });
}
