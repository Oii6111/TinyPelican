// 小鹈鹕核心 — 附件描述（首次入库时生成一次，之后 agent 直接读）
//
// 图片：能拿到支持视觉的模型就用模型写一句描述（含图里的关键文字）；
//       拿不到就退化成元数据描述，并把「当前模型不支持视觉」如实带回去。
// 文件：只做元数据和文件名推断，不抽正文（PDF 只数页数）。
'use strict';

const { chatCompletion } = require('../engine/client');
const { resolveProviderFor } = require('../engine/providers');

// 常见支持图片输入的服务商/模型名特征。用户也可以在服务商配置里显式写 supportsVision。
const VISION_MODEL_PATTERNS = [
  /gpt-4o/i, /gpt-4\.1/i, /gpt-5/i, /o4-mini/i,
  /qwen[^/]*[-_]?vl/i, /qwen[^/]*omni/i,
  /deepseek-flash/i,
  /glm-4v/i, /glm-4\.5v/i,
  /claude-3/i, /claude-4/i,
  /gemini/i, /internvl/i, /minicpm-v/i, /llava/i
];

const VISION_PROMPT = [
  '这是微信聊天里的一张图片。请用中文写一段不超过 120 字的描述，供以后检索聊天时直接使用：',
  '1) 先说这张图是什么（截图/照片/表格/单据/聊天截图等）；',
  '2) 如果图里有文字，摘出关键信息（标题、人名、数字、金额、日期、结论）；',
  '3) 不要写「这是一张图片」这类废话，不要猜测画面外的内容，不要分段。'
].join('\n');

const MAX_VISION_BYTES = 4 * 1024 * 1024;

function isVisionModel(model) {
  const name = String(model || '');
  if (!name) return false;
  return VISION_MODEL_PATTERNS.some((pattern) => pattern.test(name));
}

function unsupportedHint(provider, model) {
  return `当前模型「${model || provider || '未配置'}」不支持视觉，图片只能按元数据记录。`
    + '可在设置 → 模型服务里换成支持视觉的模型，或单独配置一个视觉模型（engine.vision）。';
}

// 决定这次拿哪个模型看图：显式配置 > 服务商声明 > 模型名判断
function visionTarget(cfg) {
  const engine = (cfg && cfg.engine) || {};
  const providers = engine.providers || {};
  const currentName = String(engine.provider || 'siliconflow');
  const current = providers[currentName] || {};
  const configured = engine.vision && typeof engine.vision === 'object' ? engine.vision : {};

  if (configured.provider || configured.model) {
    const name = String(configured.provider || currentName);
    try {
      const provider = resolveProviderFor(cfg, name);
      return { ok: true, provider: name, model: String(configured.model || provider.model), explicit: true };
    } catch (error) {
      return { ok: false, reason: 'config', error: `视觉模型配置不可用：${(error && error.message) || error}` };
    }
  }

  if (typeof current.supportsVision === 'boolean') {
    if (!current.supportsVision) return { ok: false, reason: 'unsupported', error: unsupportedHint(currentName, current.model) };
    return { ok: true, provider: currentName, model: String(current.model || ''), explicit: false };
  }

  if (isVisionModel(current.model)) {
    return { ok: true, provider: currentName, model: String(current.model), explicit: false };
  }
  return { ok: false, reason: 'unsupported', error: unsupportedHint(currentName, current.model) };
}

function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1048576) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / 1048576).toFixed(1)} MB`;
}

// 没有视觉模型时的兜底描述：类型、文件名、格式、大小，图片再带尺寸
function metadataDescription(attachment = {}) {
  const kind = attachment.kind === 'image' ? '图片' : attachment.kind === 'video' ? '视频' : '文件';
  const parts = [attachment.mimeType || '未知类型', formatSize(attachment.size)];
  if (attachment.width && attachment.height) parts.push(`${attachment.width}×${attachment.height}`);
  if (attachment.pages) parts.push(`${attachment.pages} 页`);
  const name = String(attachment.name || '').trim();
  return `${kind}${name ? `「${name}」` : ''}（${parts.join('，')}）`;
}

async function describeImage(attachment, cfg) {
  if (!/^image\//i.test(String(attachment.mimeType || ''))) return { ok: false, reason: 'unsupported', error: '不是图片' };
  if (!attachment.bytes || !attachment.bytes.length) return { ok: false, reason: 'empty', error: '图片内容为空' };
  if (attachment.bytes.length > MAX_VISION_BYTES) return { ok: false, reason: 'too-large', error: '图片超过 4MB，跳过视觉描述' };

  const target = visionTarget(cfg);
  if (!target.ok) return target;

  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: VISION_PROMPT },
      { type: 'image_url', image_url: { url: `data:${attachment.mimeType};base64,${attachment.bytes.toString('base64')}` } }
    ]
  }];
  const engine = (cfg && cfg.engine) || {};
  const result = await chatCompletion(messages, {
    config: cfg,
    providerName: target.provider,
    model: target.model,
    retries: 0,
    thinking: false,
    timeoutMs: Number(engine.visionTimeoutMs) || 30000,
    taskName: 'image-description'
  });
  if (!result.ok) return { ok: false, reason: 'call-failed', error: `视觉模型调用失败：${result.error}` };
  return { ok: true, text: String(result.text || '').trim().slice(0, 500), model: result.model || target.model };
}

// 给一个附件生成描述；永远返回可用的 description（最差也是元数据）
async function describeAttachment(attachment, cfg) {
  const meta = metadataDescription(attachment);
  if (attachment.kind !== 'image') {
    return { description: meta, descriptionSource: 'metadata', descriptionModel: '', descriptionError: '' };
  }
  const result = await describeImage(attachment, cfg);
  if (result.ok) return { description: result.text, descriptionSource: 'vision', descriptionModel: result.model || '', descriptionError: '' };
  return {
    description: meta,
    descriptionSource: 'metadata',
    descriptionModel: '',
    descriptionError: result.error || '',
    visionUnsupported: result.reason === 'unsupported' || result.reason === 'config'
  };
}

module.exports = { describeAttachment, describeImage, metadataDescription, visionTarget, isVisionModel, VISION_PROMPT, MAX_VISION_BYTES };
