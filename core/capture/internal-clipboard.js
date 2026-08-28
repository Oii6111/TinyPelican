// 内部剪贴板写入标记：回填建议时设置，剪贴板传感器短时间内忽略该变化。
'use strict';

let until = 0;

function markInternalWrite(ms = 3000) {
  until = Date.now() + ms;
}

function isInternalClipboardWrite(at = Date.now()) {
  return at < until;
}

module.exports = { markInternalWrite, isInternalClipboardWrite };
