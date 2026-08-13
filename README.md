<div align="center">

# Hangar

**Why is this running, and what happens if I turn it off?**

Local process, port and origin map — with a reversible off switch.

[![CI](https://github.com/Army161/hangar/actions/workflows/ci.yml/badge.svg)](https://github.com/Army161/hangar/actions/workflows/ci.yml)
[![Release](https://github.com/Army161/hangar/actions/workflows/release.yml/badge.svg)](https://github.com/Army161/hangar/actions/workflows/release.yml)
[![Docs](https://img.shields.io/badge/docs-github%20pages-0E2B31)](https://army161.github.io/hangar/)
![Version](https://img.shields.io/badge/version-0.4.0-E5A50A)

</div>

---

Task Manager tells you `node.exe ×76`. Hangar tells you *which* seventy-six, who
started them, when that was arranged, and what breaks if you stop them.

Everything runs locally. The process table never leaves the machine.

## Install

| Platform | File | Notes |
|---|---|---|
| **Windows** | `Hangar_0.4.0_x64-setup.exe` | Per-user, no admin prompt |
| **Windows (MSI)** | `Hangar_0.4.0_x64_en-US.msi` | For managed deployment |
| **macOS (Apple Silicon)** | `Hangar_0.4.0_aarch64.dmg` | |
| **macOS (Intel)** | `Hangar_0.4.0_x64.dmg` | |
| **Linux** | `hangar_0.4.0_amd64.AppImage` | Also `.deb` |

Grab them from [Releases](https://github.com/Army161/hangar/releases/latest).

### Or run the web version

Zero dependencies, pure Node stdlib — no `npm install` needed.

```bash
node server.js
```

Then open **http://localhost:7420**, or double-click `start.cmd`, which does both.

## Two front ends, one UI

The desktop app and the web agent render the identical interface from
`apps/desktop/src/`. They differ only in how they reach the system:

| | Desktop (Tauri) | Web (`server.js`) |
|---|---|---|
| Backend | `hangar-core` in Rust, over IPC | Node + PowerShell collectors |
| Network | **No TCP listener at all** | `127.0.0.1:7420` |
| Tray icon | Yes | No |
| Best for | Daily use | Development, headless boxes |

## Safety model

Hangar can stop processes. Every kill passes three gates, in order:

1. **Dry run** — `POST /api/plan` returns exactly what would die and what the
   guard refuses, with a confirmation phrase. Nothing is killed.
2. **Typed confirmation** — `POST /api/execute` requires the plan id *and* the
   exact phrase (`PARK 7`). Plans are single-use and expire after 5 minutes.
3. **Re-evaluation** — the guard runs again against a *fresh* process table.
   PIDs recycle, so a plan is a proposal, not a licence. Anything that shifted
   since the dry run drops out.

A restore manifest is written to `manifests/` **before the first kill**. If the
manifest cannot be written, nothing dies.

Run with `HANGAR_READONLY=1` to disable every write endpoint.

### What the guard protects

| Layer | Source | Editable |
|---|---|---|
| This session's process chain | computed live from the agent's own ancestry | no |
| The Hangar agent itself | matched by name and pid | no |
| System-critical (`svchost`, `lsass`, `csrss`, Defender, explorer, …) | `SYSTEM_DENY` in `lib/guard.js` | no |
| Your apps (Ollama, MetaTrader, OneDrive, …) | `config/protected.json` | **yes** |
| Your projects (TAO_WALLET, OUROBOROS) | `config/protected.json` | **yes** |

Protection is evaluated **after** tree expansion, on the final kill list — a
killable parent can never launder its protected children.

### Why the guard is shaped this way

On 2026-07-29 a manual cleanup killed a live MetaTrader terminal that had been
explicitly protected. Two causes: the terminal was a *child* of the target
process, and the guard emitted log strings from inside a PowerShell
`Where-Object` block, which polluted the pipeline so blocked items passed
anyway. Both failure modes are now regression tests in
[`test/guard.test.js`](test/guard.test.js). The guard is a pure function: it
returns verdict objects and never logs, and every requested pid must land in
exactly one bucket — `allowed` or `blocked`. Silent drops fail the suite.

## Restore

Restore relaunches each victim's recorded executable and argv **directly** —
not through `cmd /c`, which strips the outer quote pair and corrupts any path
containing spaces. OS-managed helpers (`conhost`, `dllhost`, `RuntimeBroker`)
are marked non-restorable and skipped: they respawn on their own.

Restore is honest about its limit: it brings the program back, not its
in-memory state.

## The views

| View | What it answers |
|---|---|
| **Owners** | What is actually running, grouped by the real thing that owns it — not `node.exe ×76`. Tick rows to park them; protected owners show a dot instead of a checkbox. Click any row for the origin trace and full command lines. |
| **Port wall** | Every listening port, probed for HTTP and labelled with its page title. Your forgotten local apps, clickable. |
| **Origins** | Everything configured to start itself, oldest first, with the date it was added. |
| **Fan-out** | The same thing running more than once, and what collapsing it would reclaim. |
| **Graveyard** | Projects that stopped being touched, ranked by what reviving or removing them would reclaim. |
| **Manifests** | Every park, newest first, with a one-click Restore. |

## How attribution works

`lib/attribute.js` resolves each PID in four passes:

1. **Signature match** against a table of known agents, MCP packages, and apps.
2. **Project path** — a folder under your home directory that isn't plumbing.
3. **Inheritance** from the nearest ancestor that matched.
4. **Executable name** as a last resort.

Memory is charged to the owner at the top of each attributed subtree, so a parent
and its children are never double-counted.

### Teaching it your projects

If Hangar labels something `node` that you know is `Portfolio Site`, add a line to
`SIGNATURES` at the top of `lib/attribute.js`:

```js
{ re: /portfolio-site/i, kind: KIND.PROJECT, name: 'Portfolio Site', reattach: true },
```

Restart the agent and it's named everywhere at once — owners list, port wall,
origin trace. Ordering matters: first match wins, so put specific patterns above
broad ones.

## How much to trust an origin trace

Every trace is labelled:

- **✓ confirmed by path** — the process binary, the launcher path in its command
  line, or a service reporting the PID directly. This is verifiable evidence.
- **~ likely** (amber badge) — inferred from distinctive name tokens shared
  between the entry and the command line. Usually right, occasionally not.

Scoring filters tokens two ways: rare across startup entries *and* rare across
running processes. That second filter matters — `hermes` is unique among startup
entries but appears in every MCP command line, because Claude's bundled toolchain
lives in a folder with that name.

**Known limitation:** an app that merely *mentions* another product can inherit
its origin. On this machine, Claude matches the Discord run key because a Claude
plugin path contains "discord". The badge is there so a wrong guess reads as a
guess. Expand the row and check `matched on` before acting on a trace.

## Origin dates, and how much to trust them

Windows doesn't timestamp individual registry values, so `addedSource` tells you
where each date actually came from:

| Source | Reliability |
|---|---|
| `file created in Startup folder` | Exact — this is a real file date |
| `task registration date` | Exact — recorded by Task Scheduler |
| `target binary date` | Approximate — the executable's date, used when nothing better exists |

The UI shows the source next to every date rather than presenting all of them as
equally firm.

## Persistence control — the changes that actually stick

Killing a process is temporary. On 2026-07-29 WSL was back within the hour
because a scheduled task relaunches it. The only cleanup on this machine that
survived a reboot was configuration-level: the 07-30 session disabled plugins
and removed extensions, and free RAM went from 632 MB to 6.9 GB permanently.

The **Origins** tab offers a reversible off switch per entry, behind the same
dry-run + typed-confirmation gates as Park.

| Kind | Disable does | Undo |
|---|---|---|
| Startup folder | **Moves** the file to `quarantine/startup/` | Moves it back |
| Registry Run | Records the value verbatim, then removes it | Recreates it |
| Scheduled task | `Disable-ScheduledTask` — definition kept | `Enable-ScheduledTask` |
| Service | `Set-Service -StartupType Disabled`, old type recorded | Restores old type |

Nothing is ever deleted. `test/persistence.test.js` asserts that no action of
any kind matches `Remove-Item`, `Unregister-*`, `Remove-Service`, or
`sc.exe delete`, in either direction.

### Extra protections beyond the process guard

Security software (`WinDefend`, `SecurityHealth`, `MsMpEng`, Sense, …) and core
services (`WSLService`, `Winmgmt`, `RpcSs`, `Schedule`, `EventLog`, …) are
refused unconditionally — they are not in `config/protected.json` and cannot be
overridden from it.

### Elevation

HKLM run keys and all services need an Administrator agent; HKCU keys, Startup
folder files, and user-owned scheduled tasks do not. The dry run **labels which
entries need admin before you confirm**, and the executor reports them as
explicitly skipped rather than failing halfway — the `cowork-svc.exe`
access-denied lesson from 07-29. To handle those, start the agent from an
elevated shell.

## Layout

```
server.js                    HTTP agent — snapshot, plan/execute/restore
lib/attribute.js             PID -> owner resolution, fan-out, origin tracing
lib/guard.js                 Kill guard — pure function, verdicts as data
lib/manifest.js              Restore manifests, argv splitting, relaunch
lib/graveyard.js             Dormant-project ranking
lib/persistence.js           Startup-entry disable/enable, reversible
lib/probe.js                 Gentle HTTP probing of local ports, cached

crates/hangar-core/          Rust core — guard, attribution, persistence
apps/desktop/src/            The dashboard (shared by both front ends)
apps/desktop/src-tauri/      Tauri v2 shell — tray, windows, bundling

config/protected.json        Your never-kill list (editable)
manifests/                   One JSON per park; the undo history
quarantine/startup/          Where disabled Startup files go — never deleted
test/                        Regression tests for every bug found in the field
scripts/collect-fast.ps1     system + processes + ports   (4s TTL)
scripts/collect-slow.ps1     startup + tasks + services   (5min TTL)
```

## API

| Method | Path | Effect |
|---|---|---|
| `GET` | `/api/snapshot` | Full state. Read-only. |
| `GET` | `/api/manifests` | Park history. |
| `POST` | `/api/plan` | Dry run. **Never kills.** Returns allowed, blocked, phrase. |
| `POST` | `/api/execute` | The only path that kills. Needs `planId` + exact `confirm`. |
| `POST` | `/api/restore` | Relaunch a manifest's victims. |
| `POST` | `/api/persist/plan` | Dry run over startup entries. **Never changes anything.** |
| `POST` | `/api/persist/execute` | Applies a confirmed persistence plan. |

## Config

| Variable | Default | Notes |
|---|---|---|
| `HANGAR_PORT` | `7420` | `set HANGAR_PORT=7421 && node server.js` |
| `HANGAR_READONLY` | unset | `1` disables all write endpoints |

## Build from source

Requires [Rust](https://rustup.rs) and [Node 22+](https://nodejs.org).

```bash
git clone https://github.com/Army161/hangar.git
cd hangar
npm install

npm run dev        # desktop app, hot reload
npm run build      # installers into target/release/bundle/
npm test           # node --test test/
cargo test --workspace
```

Linux additionally needs `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`,
`librsvg2-dev` and `patchelf`.

macOS and Linux installers **cannot** be cross-compiled from Windows — Tauri
needs the native toolchain and Apple's signing tools only run on Darwin. The
[release workflow](.github/workflows/release.yml) builds each on its own runner.

## Docs

Full guides at **[army161.github.io/hangar](https://army161.github.io/hangar/)**.

## Licence

UNLICENSED — all rights reserved.
