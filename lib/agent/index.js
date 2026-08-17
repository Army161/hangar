'use strict';
/**
 * The agent loop.
 *
 * READ and PLAN tools run autonomously — they cannot mutate anything, so there
 * is nothing to gate. EXECUTE does not run at all: request_execution returns a
 * pending state and the loop stops, handing control to the user. The loop has
 * no branch that completes a kill, so no prompt can talk it into one.
 *
 * Tool handlers are injected rather than imported. The orchestrator therefore
 * has no route to the process table except through what the server hands it —
 * which is what makes the "no shell" property testable without booting an agent.
 */

const tools = require('./tools');
const providers = require('./providers');

const MAX_STEPS = 12;

/**
 * Run one turn.
 *
 * @param {object}   o
 * @param {object}   o.model     { provider, id, apiKey?, baseUrl? }
 * @param {Array}    o.messages  prior conversation
 * @param {object}   o.handlers  { [toolName]: async (input) => any }
 * @param {function} [o.onEvent] progress callback for the UI
 */
async function run({ model, messages, handlers, onEvent = () => {}, maxSteps = MAX_STEPS }) {
  const convo = [...messages];
  const trace = [];
  let steps = 0;

  while (steps < maxSteps) {
    steps += 1;

    const res = await providers.chat({
      provider: model.provider,
      model: model.id,
      apiKey: model.apiKey,
      baseUrl: model.baseUrl,
      system: tools.SYSTEM_CONTRACT,
      messages: convo,
    });

    if (!res.ok) {
      onEvent({ type: 'error', error: res.error });
      return { ok: false, error: res.error, trace, steps };
    }

    if (res.text) onEvent({ type: 'text', text: res.text });

    if (!res.toolCalls || res.toolCalls.length === 0) {
      convo.push({ role: 'assistant', content: res.text || '' });
      return { ok: true, text: res.text || '', messages: convo, trace, steps, usage: res.usage };
    }

    convo.push({ role: 'assistant', content: res.text || '', toolCalls: res.toolCalls });

    const results = [];
    for (const call of res.toolCalls) {
      const def = tools.find(call.name);

      if (!def) {
        // A hallucinated tool name. Report it as a failed call rather than
        // throwing — the model can recover, and a crash here would end the turn.
        results.push({ id: call.id, name: call.name, error: `No such tool: ${call.name}` });
        onEvent({ type: 'tool-error', name: call.name, error: 'unknown tool' });
        continue;
      }

      // The gate. EXECUTE never runs; it becomes a pending hand-off and the
      // loop stops so the user is not left waiting behind further tool calls.
      if (def.tier === tools.TIER.EXECUTE) {
        const pending = tools.requestExecution(call.input.planId, { plan: null });
        onEvent({ type: 'awaiting-confirmation', planId: call.input.planId });
        trace.push({ tool: call.name, tier: def.tier, pending: true });
        return {
          ok: true,
          awaitingConfirmation: true,
          planId: call.input.planId,
          text: res.text || '',
          messages: convo,
          trace,
          steps,
          note: pending.message,
        };
      }

      const handler = handlers[call.name];
      if (!handler) {
        results.push({ id: call.id, name: call.name, error: `Tool "${call.name}" is not wired up on this build.` });
        continue;
      }

      onEvent({ type: 'tool-start', name: call.name, input: call.input });
      try {
        const raw = await handler(call.input || {});
        // Everything the process table produced is attacker-choosable, so it is
        // fenced before the model ever sees it.
        const { value, injectionFlags } = tools.sanitiseResult(raw, call.name);
        if (injectionFlags.length) {
          onEvent({ type: 'injection-flagged', name: call.name, fields: injectionFlags });
        }
        results.push({ id: call.id, name: call.name, result: value });
        trace.push({ tool: call.name, tier: def.tier, flagged: injectionFlags.length });
        onEvent({ type: 'tool-end', name: call.name, flagged: injectionFlags.length });
      } catch (e) {
        results.push({ id: call.id, name: call.name, error: e.message });
        onEvent({ type: 'tool-error', name: call.name, error: e.message });
      }
    }

    convo.push({ role: 'user', content: JSON.stringify(results), toolResults: results });
  }

  // Hitting the ceiling is a real outcome, not an error to swallow.
  onEvent({ type: 'max-steps', steps });
  return { ok: true, text: '', messages: convo, trace, steps, hitStepLimit: true };
}

module.exports = { run, MAX_STEPS, tools, providers, models: require('./models') };
