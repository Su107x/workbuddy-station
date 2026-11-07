'use strict';
/**
 * SSE 处理：解析上游分片 + 聚合为 OpenAI 非流式响应。
 *
 * 背景：workbuddy.cn 的 /v2/chat/completions 只接受 stream:true，
 * 非流式请求会返回 400（code 11101 "Non-stream chat request is currently not supported"）。
 * 所以网关对外要做双向适配：
 *   - 客户端要流式  → 直接透传上游 SSE
 *   - 客户端要非流式 → 读干上游 SSE，聚合出一条标准 chat.completion
 */

/** 解析一段 SSE 文本，返回 { frames:[已解析JSON], done:bool, raw:[] } */
function parseSSE(text) {
  const frames = [];
  const raw = [];
  let done = false;
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (!t.startsWith('data:')) {
      raw.push(t);
      continue;
    }
    const payload = t.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') {
      done = true;
      continue;
    }
    try {
      frames.push(JSON.parse(payload));
    } catch (_) {
      raw.push(t);
    }
  }
  return { frames, done, raw };
}

/** 从 SSE 文本中直接找出错误帧（上游有时在 200 里塞 error 对象） */
function findErrorFrame(frames) {
  for (const f of frames) {
    if (f && typeof f === 'object') {
      if (f.error) return f.error;
      const code = f.code;
      if (typeof code === 'number' && code !== 0 && f.msg) return f;
    }
  }
  return null;
}

/**
 * 把若干 OpenAI chunk 聚合成一条 chat.completion。
 * 处理：content 拼接、reasoning_content 拼接、tool_calls 按 index 合并 arguments。
 */
function aggregateChunks(frames, opts) {
  const o = opts || {};
  let id = o.id || 'chatcmpl-aggregate';
  let model = o.model || 'unknown';
  let created = Math.floor(Date.now() / 1000);
  let content = '';
  let reasoning = '';
  let refusal = '';
  let finishReason = null;
  let usage = null;
  const slots = new Map();

  for (const f of frames) {
    if (!f || typeof f !== 'object') continue;
    if (typeof f.id === 'string' && f.id) id = f.id;
    if (typeof f.model === 'string' && f.model) model = f.model;
    if (typeof f.created === 'number') created = f.created;
    if (f.usage && typeof f.usage === 'object') usage = f.usage;
    const choice = Array.isArray(f.choices) ? f.choices[0] : null;
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const d = choice.delta || choice.message || {};
    if (typeof d.content === 'string') content += d.content;
    else if (Array.isArray(d.content)) {
      // 多模态/数组 content：转成文本片段
      for (const part of d.content) {
        if (part && typeof part.text === 'string') content += part.text;
      }
    }
    if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
    else if (typeof d.reasoning === 'string') reasoning += d.reasoning;
    if (typeof d.refusal === 'string') refusal += d.refusal;
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const idx = Number.isInteger(tc && tc.index) ? tc.index : slots.size;
        let slot = slots.get(idx);
        if (!slot) {
          slot = { id: '', type: 'function', function: { name: '', arguments: '' } };
          slots.set(idx, slot);
        }
        if (tc.id) slot.id = tc.id;
        if (tc.type) slot.type = tc.type;
        if (tc.function) {
          if (tc.function.name) slot.function.name += tc.function.name;
          if (typeof tc.function.arguments === 'string') slot.function.arguments += tc.function.arguments;
        }
      }
    }
  }

  const toolCalls = Array.from(slots.keys()).sort((a, b) => a - b).map((k) => slots.get(k));

  const message = { role: 'assistant', content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (refusal) message.refusal = refusal;
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, logprobs: null, finish_reason: finishReason || 'stop' }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

module.exports = { parseSSE, findErrorFrame, aggregateChunks };
