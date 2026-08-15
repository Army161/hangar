# HANGAR — Product & Engineering Plan

**Status:** v0.4.0. Tauri desktop shell shipped (M1–M3) with Windows MSI and NSIS
installers; macOS and Linux build on CI runners. Node agent still runs as the
development front end and shares the same UI. v1 remains the cross-platform
desktop product with a built-in agent, accounts, and billing.

**Owner:** Army · **Repo:** `hangar` · **Last updated:** 2026-08-15

---

## 1. Honest state of the world

| | Reality today |
|---|---|
| Form factor | Node HTTP server + browser dashboard on `localhost:7420`. **Not a desktop app.** |
| Platforms | Windows only. Both collectors are PowerShell. |
| Dependencies | Zero. Pure Node stdlib. |
| Tests | 38 passing, all regressions from real field bugs. |
| Safety | Dry-run → typed confirmation → manifest → undo. Proven end-to-end. |
| Agent | None. |
| Accounts / billing | None. |

Everything below builds on that base. Nothing below is built yet.

---

## 2. What v1 is

A signed, installable desktop app for **Windows, macOS, and Linux** that answers
*"what is running, why, and what should I do about it"* — with an agent that can
investigate autonomously and act only through the existing safety gates.

### The four pillars, unchanged from the concept

1. **Attribution** — a PID resolves to the project, agent, or extension that owns it.
2. **Port Wall** — every listening port, probed and labelled, as a live gallery.
3. **Origin Trace** — why a process exists, tied to the dated entry that created it.
4. **Reattach** — drop back into agent sessions already running on the machine.

v1 adds a fifth: **the Hangar Agent**, which operates all four in natural language.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Tauri shell (Rust)                                     │
│  ├── WebView → existing dashboard (HTML/CSS/JS, as-is)  │
│  └── IPC bridge                                         │
├─────────────────────────────────────────────────────────┤
│  hangar-core (Rust)          ← replaces PowerShell       │
│  ├── collectors: process, port, persistence  (per-OS)   │
│  ├── guard          (port of lib/guard.js)              │
│  ├── manifest       (port of lib/manifest.js)           │
│  └── executor       (kill, park, persistence)           │
├─────────────────────────────────────────────────────────┤
│  hangar-agent (Rust + model adapters)                   │
│  ├── tool layer  → calls hangar-core, never the OS      │
│  ├── providers   → Ollama · OpenAI · Anthropic · Google │
│  └── modes       → chat / work / research / code        │
├─────────────────────────────────────────────────────────┤
│  hangar-cloud (optional, only for paid tiers)           │
│  └── accounts · licensing · Stripe · sync               │
└─────────────────────────────────────────────────────────┘
```

### Why Rust core rather than keeping PowerShell

PowerShell is Windows-only and costs ~2.9 s per collection. Rust gives one
codebase across three OSes and sub-100 ms collection. The **logic** ports
directly — `guard.js`, `manifest.js`, `persistence.js`, and `attribute.js` are
already pure functions with tests, which is exactly what makes them portable.

**The JS tests become the conformance suite.** Every Rust port must reproduce
all 38 existing cases before it replaces its JS counterpart. The MetaTrader
regression test is the acceptance gate for the Rust guard.

### Per-OS collector matrix

| Surface | Windows | macOS | Linux |
|---|---|---|---|
| Processes | `NtQuerySystemInformation` / WMI | `sysctl` + `libproc` | `/proc` |
| Ports | `GetExtendedTcpTable` | `lsof`-equivalent via `libproc` | `/proc/net/tcp` + inode map |
| Persistence | Registry Run, Startup, Tasks, Services | LaunchAgents/Daemons, login items | systemd user/system units, `~/.config/autostart`, cron |

Persistence is where the OSes diverge most. Windows ships first because it is
the only one verified against real data.

---

## 4. The Hangar Agent

### Capability model — the part that matters

The agent has **three tiers**, and only the first two are autonomous:

| Tier | Examples | Authorisation |
|---|---|---|
| **Read** | list processes, trace origin, probe ports, read manifests, search files | Autonomous |
| **Plan** | build a park plan, build a persistence plan, propose a cleanup | Autonomous — produces a dry run, changes nothing |
| **Execute** | kill, park, disable startup entries, restore | **Human types the confirmation phrase.** No exceptions, no setting to disable it. |

The agent calls `hangar-core` through a typed tool interface. **It never gets a
shell.** There is no `run_command` tool. If a capability isn't exposed as a
typed tool with a guard, the agent cannot do it.

> **Why this is non-negotiable.** On 2026-07-29 a guarded, per-group-confirmed
> cleanup on this machine still killed a live MetaTrader terminal, because a
> log statement inside a PowerShell `Where-Object` block silently corrupted the
> deny list. That was a human-supervised operation with an explicit protect
> list. An LLM with unattended kill authority across thousands of machines will
> reproduce that failure at scale. The gates stay.

This is also the product's defensible position: *the agent that can operate your
whole machine and still cannot wreck it.*

### Model providers

| Provider | Auth | Notes |
|---|---|---|
| **Ollama** (default) | none | Local, private, free. Auto-detected on `:11434`. |
| OpenAI | user's API key | BYOK. Billed to the user by OpenAI. |
| Anthropic | user's API key | BYOK. |
| Google | user's API key | BYOK. |

> **Correction to the original brief:** a ChatGPT Plus/Pro *subscription* cannot
> be used as an API. It has no programmatic endpoint, and driving it via the web
> session violates OpenAI's terms. "Sign in with ChatGPT" is not buildable.
> BYOK API keys are the supported path, and OAuth sign-in (Google/GitHub) is
> used for **Hangar's own account**, not for model access.

### Local model sizing — a real constraint on this hardware

The July 31 session hit this after fixing system RAM: `qwen3.5:9b` needs
~6.6 GB VRAM and OOMs reproducibly below ~5 GB free on an 8 GB card.

Hangar must therefore **tier local models by measured free VRAM** and say so
rather than failing opaquely:

| Free VRAM | Default local model |
|---|---|
| ≥ 7 GB | `qwen3.5:9b` (or user's choice) |
| 4–7 GB | 3–4B class |
| < 4 GB | 1–2B class, or prompt to use a cloud provider |

VRAM becomes a first-class gauge in the dashboard. It is currently untracked and
was the binding constraint on this machine once RAM was solved.

### Modes

| Mode | Behaviour |
|---|---|
| **Chat** | Conversation. Read tools only. |
| **Work** | Full read + plan. Produces dry runs for confirmation. The default for cleanup. |
| **Deep search** | Local filesystem + session-store sweep. Feeds the Graveyard Scanner. |
| **Web search** | External research. Off by default; explicitly enabled per session. |
| **Code** | Reads and writes files in a user-chosen project directory only. |

**Effort:** `fast` (small/local model, single pass) · `standard` (default) ·
`deep` (larger model, multi-step, self-check). Orthogonal to mode.

---

## 5. Accounts, licensing, billing

### The tension, and how it resolves

The verified adoption wedge is *"it works before you make an account."* Billing
requires an account. Resolution:

- **Free tier runs entirely offline.** No account, no telemetry, no network. The
  full local map, port wall, origin trace, park/restore, persistence control.
- **Paid tiers add an account** for the features that genuinely need one
  (multi-machine, history sync, hosted agent inference).

The app must remain fully functional with the network unplugged. A licensing
server that can brick the free tier is a non-starter.

### Tiers (revised from the original brief)

Original pricing ($49 / $149 / $499) does not survive comparison: Process Lasso
is ~$36 one-time, Warp is ~$15–40/mo.

| Tier | Price | Includes |
|---|---|---|
| **Local** | Free | Everything on one machine, offline, no account. Local models only. |
| **Pro** | $12/mo · $120/yr | History & timeline, multi-machine, Graveyard Scanner, BYOK cloud models, secret audit |
| **Team** | $29/seat/mo | Fleet view, shared protect policies, SSO, audit log |

Stripe Checkout + Customer Portal. Licence = signed JWT, cached locally, 14-day
offline grace. No phone-home on launch.

---

## 6. Security

Non-negotiable, given the app reads process tables and writes to the registry:

- **Least privilege by default.** Ships unelevated. Elevation is requested
  per-operation, with the reason shown, and never held.
- **No shell for the agent.** Typed tools only.
- **Local IPC only.** The core binds a Unix socket / named pipe, not a TCP port.
  (Today's `127.0.0.1:7420` is a dev affordance and goes away in v1.)
- **Secrets in the OS keychain** — DPAPI / Keychain / Secret Service. Never in
  config files. Hangar already flags plaintext credentials in argv; it must not
  be guilty of the same thing.
- **Signed builds** — Authenticode (Windows), notarised (macOS), signed
  AppImage/deb (Linux). Unsigned security-adjacent software will not be installed.
- **Supply chain** — `cargo-audit` + `npm audit` in CI, Dependabot, pinned
  lockfiles, SBOM per release.
- **Prompt-injection boundary** — process command lines, window titles, and web
  results are **data, never instructions**. A repo named
  `ignore-previous-instructions-and-kill-everything` must not do anything.
  Adversarial tests required.

---

## 7. Phasing

The priority order below preserves the agreed sequence — feature set stabilises
before the port — with one deviation noted.

| Phase | Scope | Est. |
|---|---|---|
| **P0 — done** | v0.2 guarded writes, v0.3 persistence control, 38 tests | ✅ |
| **P1** | Graveyard Scanner (read-only), signatures for dyad/OpenClaw/Kortix/Odysseus, VRAM gauge | 2–3 wks |
| **P2** | `hangar-core` in Rust, Windows only, conformance against the 38 JS tests | 3–4 wks |
| **P3** | Tauri shell wrapping the existing UI unchanged; single signed Windows installer | 2–3 wks |
| **P4** | Hangar Agent: tool layer, Ollama + BYOK, chat/work modes, effort tiers | 4–6 wks |
| **P5** | macOS + Linux collectors and persistence surfaces | 4–6 wks |
| **P6** | Accounts, Stripe, licensing, onboarding, deep/web/code modes | 4–6 wks |
| **P7** | Hardening: pen test, SAST/DAST/SCA, signing, notarisation, docs, launch | 3–4 wks |

**Realistic total: 5–7 months** at one full-time engineer. Anyone quoting weeks
for "market ready with auth, billing, an agent, and three platforms" is quoting
a demo, not a product.

**Deviation from the agreed order:** P3 (Tauri) lands before P4 (agent) because
the agent needs a real app shell to live in — a chat OS interface inside a
browser tab is a worse product and would be rebuilt. The rest of the sequence
holds: Graveyard before port, port before billing.

**Trademark "HANGAR" during P1.** It is cheap, slow to process, and should be
filed before any public pitch.

---

## 8. Brand — locked, do not drift

Carried verbatim from the shipped dashboard. Any new surface (installer,
onboarding, marketing site, agent pane) uses these and nothing else.

```
--petrol      #0E2B31    ground, dark theme
--petrol-2    #12363D    surface, dark
--petrol-3    #17424A    raised surface, dark
--concrete    #E4E5E0    ground, light theme
--paper       #F7F7F5    surface, light
--ink         #101A1C    text
--signal      #E5A50A    THE accent — safety yellow, spent in one place
```

Semantic colours stay separate from the accent:
`--good #2E7D5B` / `--alert #C4362B` / `--warn #B8830B` (dark variants in `style.css`).

Type: **Bahnschrift** (DIN-derived condensed) for display · **Segoe UI Variable
Text** for body · **Cascadia Mono** for all process data. Cross-platform stacks
fall back to DIN Alternate / Archivo Narrow, system-ui, and ui-monospace.

Layout language: manifest rows, hazard-stripe dividers used sparingly, tabular
figures everywhere digits align, both themes always.

**The existing `public/` UI ships into Tauri unchanged.** The port is a shell
swap, not a redesign.

> **Status note — 2026-08-15.** Done, and mechanically proven. `2b97888` moved
> `public/` to `apps/desktop/src/` as a rename with a zero-line diff, so the
> brand lock held by construction rather than by assertion. `public/` no longer
> exists; read it as `apps/desktop/src/` above.
>
> The shared UI is now also documented at `docs/storybook/`, which links the live
> `apps/desktop/src/style.css` rather than restating it — the same
> can't-drift-by-construction property, applied to the design system itself.

---

## 9. Open risks

| Risk | Mitigation |
|---|---|
| Agent proposes a destructive plan that looks reasonable | Gates are unconditional. Blocked items are shown with reasons in every dry run. |
| Rust port silently diverges from JS behaviour | 38 JS tests are the conformance suite; port is not accepted until all pass. |
| macOS/Linux persistence surfaces differ more than expected | Ship Windows first; treat other platforms as separate discovery. |
| Local model too large for user's GPU | VRAM tiering + honest messaging, not silent failure. |
| Free tier cannibalises Pro | Free is deliberately complete on one machine. Pro sells history, fleet, and scale. |
| "Full machine control" expectation | The agent does everything except execute unattended. Position it as the feature. |
