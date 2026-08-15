'use strict';
/**
 * Model catalogue and runtime discovery.
 *
 * A hardcoded list of "every current model" is wrong within weeks — providers
 * ship models faster than this file can be released. So the catalogue here is
 * only what needs to be known *before* a key exists: defaults, pricing, and
 * which models cost nothing to run.
 *
 * Everything else is discovered at runtime from the provider itself:
 *
 *   Ollama                 GET /api/tags     — what is actually pulled locally
 *   OpenAI-compatible      GET /v1/models    — OpenAI, Groq, Together, OpenRouter,
 *                                              LM Studio, llama.cpp, vLLM
 *
 * That covers "list all current models" without this file ever going stale, and
 * it lists what the user can *actually* run rather than what existed at build
 * time. Anthropic has no public list endpoint on the same shape, so its entries
 * are curated — IDs verified 2026-08-15.
 *
 * FREE means free to *run*: local models cost nothing but your own hardware,
 * and a few hosted providers have genuine free tiers. It does not mean
 * unlimited — hosted free tiers rate-limit.
 */

const PROVIDERS = Object.freeze({
  ollama: {
    id: 'ollama',
    label: 'Ollama',
    local: true,
    free: true,
    needsKey: false,
    baseUrl: 'http://127.0.0.1:11434',
    discover: '/api/tags',
    blurb: 'Runs on your machine. No key, no account, no data leaves the box.',
  },
  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio',
    local: true,
    free: true,
    needsKey: false,
    baseUrl: 'http://127.0.0.1:1234',
    discover: '/v1/models',
    blurb: 'Local OpenAI-compatible server.',
  },
  llamacpp: {
    id: 'llamacpp',
    label: 'llama.cpp',
    local: true,
    free: true,
    needsKey: false,
    baseUrl: 'http://127.0.0.1:8080',
    discover: '/v1/models',
    blurb: 'Local OpenAI-compatible server.',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    local: false,
    free: false,
    needsKey: true,
    baseUrl: 'https://api.anthropic.com',
    blurb: 'Claude. Bring your own API key; billed by Anthropic.',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    local: false,
    free: false,
    needsKey: true,
    baseUrl: 'https://api.openai.com',
    discover: '/v1/models',
    blurb: 'Bring your own API key; billed by OpenAI.',
  },
  google: {
    id: 'google',
    label: 'Google',
    local: false,
    free: 'tier',
    needsKey: true,
    baseUrl: 'https://generativelanguage.googleapis.com',
    discover: '/v1beta/models',
    blurb: 'Gemini. Has a genuine free tier with rate limits.',
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    local: false,
    free: 'tier',
    needsKey: true,
    baseUrl: 'https://api.groq.com/openai',
    discover: '/v1/models',
    blurb: 'Very fast hosted open models. Free tier with rate limits.',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    local: false,
    free: 'tier',
    needsKey: true,
    baseUrl: 'https://openrouter.ai/api',
    discover: '/v1/models',
    blurb: 'Router across many providers. Some models are free.',
  },
});

/**
 * Curated defaults. Deliberately short — this is a starting point, not an
 * inventory. Anthropic IDs verified 2026-08-15; they carry no date suffix.
 *
 * `ctx` is the context window in tokens. `in`/`out` are USD per million tokens.
 */
const CURATED = Object.freeze([
  // --- Anthropic ----------------------------------------------------------
  { provider: 'anthropic', id: 'claude-opus-5', label: 'Claude Opus 5', ctx: 1_000_000, in: 5, out: 25, note: 'Default. Strongest for agentic work.' },
  { provider: 'anthropic', id: 'claude-sonnet-5', label: 'Claude Sonnet 5', ctx: 1_000_000, in: 3, out: 15, note: 'Best speed/intelligence balance.' },
  { provider: 'anthropic', id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', ctx: 200_000, in: 1, out: 5, note: 'Fastest and cheapest.' },
  { provider: 'anthropic', id: 'claude-fable-5', label: 'Claude Fable 5', ctx: 1_000_000, in: 10, out: 50, note: 'Most capable; highest cost.' },
  { provider: 'anthropic', id: 'claude-opus-4-8', label: 'Claude Opus 4.8', ctx: 1_000_000, in: 5, out: 25 },

  // --- Local, free to run -------------------------------------------------
  // Suggestions only — the real list comes from /api/tags at runtime.
  { provider: 'ollama', id: 'qwen3:8b', label: 'Qwen 3 8B', free: true, vramGb: 6, note: 'Good default if you have ~6 GB free VRAM.' },
  { provider: 'ollama', id: 'qwen3:4b', label: 'Qwen 3 4B', free: true, vramGb: 3 },
  { provider: 'ollama', id: 'llama3.2:3b', label: 'Llama 3.2 3B', free: true, vramGb: 3 },
  { provider: 'ollama', id: 'phi4', label: 'Phi-4', free: true, vramGb: 10 },
  { provider: 'ollama', id: 'gemma3:4b', label: 'Gemma 3 4B', free: true, vramGb: 3 },
  { provider: 'ollama', id: 'mistral', label: 'Mistral 7B', free: true, vramGb: 5 },
]);

/**
 * VRAM tiering, per PLAN §4.
 *
 * The 2026-07-31 session established this empirically on this machine: a 9B
 * model needs ~6.6 GB and OOMs reproducibly below ~5 GB free on an 8 GB card.
 * Saying so plainly beats letting a model load and fail.
 */
function recommendLocal(freeVramGb) {
  if (!Number.isFinite(freeVramGb)) return { tier: 'unknown', advice: 'VRAM not detected — pick a model manually.' };
  if (freeVramGb >= 7) return { tier: 'large', maxParams: '8-9B', advice: `${freeVramGb.toFixed(1)} GB free — 8B class models fit comfortably.` };
  if (freeVramGb >= 4) return { tier: 'medium', maxParams: '3-4B', advice: `${freeVramGb.toFixed(1)} GB free — stay at 3-4B; 8B will OOM.` };
  return { tier: 'small', maxParams: '1-2B', advice: `${freeVramGb.toFixed(1)} GB free — use a 1-2B model, or a cloud provider with your own key.` };
}

// --- runtime discovery ------------------------------------------------------

function fetchJson(url, { headers = {}, timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? require('https') : require('http');
    const req = mod.get(url, { headers, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return resolve({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode}` });
        }
        try { resolve({ ok: true, data: JSON.parse(body) }); }
        catch { resolve({ ok: false, error: 'invalid JSON' }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

/** What is actually pulled locally. No key, no account. */
async function discoverOllama(baseUrl = PROVIDERS.ollama.baseUrl) {
  const res = await fetchJson(`${baseUrl}/api/tags`);
  if (!res.ok) return { ok: false, provider: 'ollama', error: res.error, models: [] };
  const models = (res.data.models || []).map((m) => ({
    provider: 'ollama',
    id: m.name,
    label: m.name,
    free: true,
    sizeGb: m.size ? Number((m.size / 1e9).toFixed(1)) : null,
    family: m.details && m.details.family,
    params: m.details && m.details.parameter_size,
    quant: m.details && m.details.quantization_level,
  }));
  return { ok: true, provider: 'ollama', models };
}

/** Any OpenAI-compatible /v1/models endpoint. */
async function discoverOpenAICompatible(provider, { baseUrl, apiKey } = {}) {
  const p = PROVIDERS[provider];
  if (!p || !p.discover) return { ok: false, provider, error: 'no discovery endpoint', models: [] };
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const res = await fetchJson(`${baseUrl || p.baseUrl}${p.discover}`, { headers });
  if (!res.ok) return { ok: false, provider, error: res.error, models: [] };

  const list = res.data.data || res.data.models || [];
  const models = list.map((m) => ({
    provider,
    id: m.id || m.name,
    label: m.id || m.name,
    // OpenRouter reports pricing as strings; "0" means genuinely free.
    free: m.pricing ? Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0 : Boolean(p.free === true),
    ctx: m.context_length || m.context_window || null,
  })).filter((m) => m.id);

  return { ok: true, provider, models };
}

/** Everything reachable right now, with unreachable providers reported. */
async function discoverAll(keys = {}) {
  const jobs = [discoverOllama()];
  for (const id of ['lmstudio', 'llamacpp', 'openai', 'groq', 'openrouter']) {
    if (PROVIDERS[id].needsKey && !keys[id]) continue;
    jobs.push(discoverOpenAICompatible(id, { apiKey: keys[id] }));
  }
  const results = await Promise.all(jobs);
  return {
    providers: results.map((r) => ({ provider: r.provider, ok: r.ok, error: r.error || null, count: r.models.length })),
    models: results.flatMap((r) => r.models),
  };
}

function curatedFor(provider) { return CURATED.filter((m) => m.provider === provider); }
function freeModels() { return CURATED.filter((m) => m.free); }

module.exports = {
  PROVIDERS, CURATED,
  recommendLocal, discoverOllama, discoverOpenAICompatible, discoverAll,
  curatedFor, freeModels,
};
