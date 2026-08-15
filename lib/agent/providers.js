'use strict';
/**
 * Provider adapters — one interface over three wire formats.
 *
 *   anthropic   POST /v1/messages            tools[], content blocks
 *   openai      POST /v1/chat/completions    tools[], tool_calls
 *   ollama      POST /api/chat               tools[], message.tool_calls
 *
 * Groq, Together, OpenRouter, LM Studio, llama.cpp and vLLM all speak the
 * OpenAI shape, so they reuse that adapter with a different base URL.
 *
 * Keys never appear in a URL — always a header. A key in a query string ends up
 * in proxy logs, browser history, and referrer headers, and this agent is
 * pointed at localhost by default where any of those may be shared.
 */

const { TOOLS, TIER } = require('./tools');

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

/** JSON Schema for one tool, from the compact declaration in tools.js. */
function schemaFor(tool) {
  const props = {};
  const required = [];
  for (const [name, spec] of Object.entries(tool.input || {})) {
    const optional = spec.endsWith('?');
    const raw = optional ? spec.slice(0, -1) : spec;
    let node;
    if (raw.endsWith('[]')) node = { type: 'array', items: { type: raw.startsWith('number') ? 'number' : 'string' } };
    else if (raw === 'number') node = { type: 'number' };
    else if (raw === 'boolean') node = { type: 'boolean' };
    else if (raw.includes('|')) node = { type: 'string', enum: raw.split('|') };
    else node = { type: 'string' };
    props[name] = node;
    if (!optional) required.push(name);
  }
  return { type: 'object', properties: props, required, additionalProperties: false };
}

function toolsForAnthropic() {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: schemaFor(t) }));
}

function toolsForOpenAI() {
  return TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: schemaFor(t) },
  }));
}

// --- transport --------------------------------------------------------------

function postJson(url, body, { headers = {}, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? require('https') : require('http');
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const u = new URL(url);
    const req = mod.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, ...headers },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch { /* keep raw */ }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          // Surface the provider's own message — "401" alone tells the user
          // nothing about which key is wrong or why.
          const msg = (data && (data.error?.message || data.error?.type || data.message)) || raw.slice(0, 300);
          return resolve({ ok: false, status: res.statusCode, error: msg || `HTTP ${res.statusCode}` });
        }
        resolve({ ok: true, data });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: `timed out after ${timeoutMs / 1000}s` }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end(payload);
  });
}

// --- adapters ---------------------------------------------------------------
//
// Each returns the same normalised shape:
//   { ok, text, toolCalls: [{ id, name, input }], raw, usage }

async function chatAnthropic({ model, system, messages, apiKey, baseUrl, maxTokens }) {
  if (!apiKey) return { ok: false, error: 'No Anthropic API key. Add one in Settings → Agent.' };

  const res = await postJson(`${baseUrl || 'https://api.anthropic.com'}/v1/messages`, {
    model,
    max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
    system,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    tools: toolsForAnthropic(),
  }, { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION });

  if (!res.ok) return res;

  const blocks = res.data.content || [];
  return {
    ok: true,
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input || {} })),
    stopReason: res.data.stop_reason,
    usage: res.data.usage,
    raw: res.data,
  };
}

async function chatOpenAI({ model, system, messages, apiKey, baseUrl, maxTokens, provider }) {
  const p = require('./models').PROVIDERS[provider] || {};
  if (p.needsKey && !apiKey) return { ok: false, error: `No ${p.label || provider} API key. Add one in Settings → Agent.` };

  const res = await postJson(`${baseUrl || p.baseUrl}/v1/chat/completions`, {
    model,
    max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
    messages: [{ role: 'system', content: system }, ...messages],
    tools: toolsForOpenAI(),
  }, apiKey ? { Authorization: `Bearer ${apiKey}` } : {});

  if (!res.ok) return res;

  const choice = (res.data.choices || [])[0] || {};
  const msg = choice.message || {};
  return {
    ok: true,
    text: msg.content || '',
    toolCalls: (msg.tool_calls || []).map((c) => ({
      id: c.id,
      name: c.function?.name,
      // Arguments arrive as a JSON *string*; a model can emit malformed JSON,
      // and that must read as a bad tool call rather than crashing the turn.
      input: safeParse(c.function?.arguments),
    })),
    stopReason: choice.finish_reason,
    usage: res.data.usage,
    raw: res.data,
  };
}

async function chatOllama({ model, system, messages, baseUrl, maxTokens }) {
  const res = await postJson(`${baseUrl || 'http://127.0.0.1:11434'}/api/chat`, {
    model,
    stream: false,
    messages: [{ role: 'system', content: system }, ...messages],
    tools: toolsForOpenAI().map((t) => ({ type: 'function', function: t.function })),
    options: { num_predict: maxTokens || DEFAULT_MAX_TOKENS },
  });

  if (!res.ok) {
    // The single most common failure, and the error text alone doesn't say it.
    if (/ECONNREFUSED|timed out/i.test(res.error || '')) {
      return { ok: false, error: 'Ollama is not answering on 127.0.0.1:11434. Is it running?' };
    }
    return res;
  }

  const msg = res.data.message || {};
  return {
    ok: true,
    text: msg.content || '',
    toolCalls: (msg.tool_calls || []).map((c, i) => ({
      id: c.id || `call_${i}`,
      name: c.function?.name,
      // Ollama returns arguments as an object, unlike OpenAI's JSON string.
      input: typeof c.function?.arguments === 'string' ? safeParse(c.function.arguments) : (c.function?.arguments || {}),
    })),
    stopReason: res.data.done_reason,
    usage: res.data.eval_count ? { output_tokens: res.data.eval_count, input_tokens: res.data.prompt_eval_count } : null,
    raw: res.data,
  };
}

function safeParse(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return { __malformed: String(s).slice(0, 500) }; }
}

const OPENAI_SHAPED = ['openai', 'groq', 'openrouter', 'lmstudio', 'llamacpp', 'together', 'vllm'];

/** Dispatch to the right adapter. */
async function chat(opts) {
  const { provider } = opts;
  if (provider === 'anthropic') return chatAnthropic(opts);
  if (provider === 'ollama') return chatOllama(opts);
  if (OPENAI_SHAPED.includes(provider)) return chatOpenAI(opts);
  return { ok: false, error: `Unknown provider "${provider}".` };
}

module.exports = {
  chat, chatAnthropic, chatOpenAI, chatOllama,
  toolsForAnthropic, toolsForOpenAI, schemaFor, OPENAI_SHAPED, TIER,
};
