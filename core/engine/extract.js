// 小鹈鹕核心 — 模型结构化输出解析
'use strict';

// 从模型文本中提取 JSON 数组（容忍 Markdown 代码块与前后缀）
function extractJsonArray(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
  try {
    const arr = JSON.parse(cleaned);
    return Array.isArray(arr) ? arr : null;
  } catch {}
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const arr = JSON.parse(match[0]);
      return Array.isArray(arr) ? arr : null;
    } catch {}
  }
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const obj = JSON.parse(objMatch[0]);
      return Array.isArray(obj) ? obj : [obj];
    } catch {}
  }
  return null;
}

function parseJsonObject(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
  try {
    const obj = JSON.parse(cleaned);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]);
      return obj && typeof obj === 'object' ? obj : null;
    } catch {}
  }
  return null;
}

module.exports = { extractJsonArray, parseJsonObject };
