// 内部剪贴板写入标记：只忽略与内部写入内容完全相同的那一次变化，避免吞掉用户随后的正常复制。
'use strict';

let expectedText = null;
let consumed = false;

function markInternalWrite(text) {
  expectedText = String(text == null ? '' : text);
  consumed = false;
}

function isInternalClipboardWrite(text) {
  if (expectedText === null) return false;
  if (consumed) return false;
  if (String(text == null ? '' : text) === expectedText) {
    consumed = true;
    return true;
  }
  return false;
}

function clearInternalWrite() {
  expectedText = null;
  consumed = false;
}

module.exports = { markInternalWrite, isInternalClipboardWrite, clearInternalWrite };
