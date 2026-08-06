//! Application state and the gated write path.
//!
//! The three gates from the Node build are reproduced exactly, because they
//! exist in response to a real incident rather than as ceremony:
//!
//!   1. `plan_*` returns a dry run and changes nothing.
//!   2. `execute_*` requires the plan id AND the exact confirmation phrase.
//!      Plans are single-use and expire after five minutes.
//!   3. Execute re-evaluates the guard against a FRESH process table. PIDs
//!      recycle, so a plan is a proposal, not a licence.
//!
//! The manifest is written before the first change. If that write fails,
//! nothing happens.

use hangar_core::{
    attribute, collect, executor, guard,
    manifest::{Store, Victim},
    persistence,
    types::{PersistenceEntry, ProtectedConfig, Process},
};
use std::collections::HashMap;
use std::time::{Duration, Instant};

const PLAN_TTL: Duration = Duration::from_secs(5 * 60);

struct KillPlanRecord {
    pids: Vec<u32>,
    include_tree: bool,
    allowed_pids: Vec<u32>,
    phrase: String,
    created: Instant,
    used: bool,
}

struct PersistPlanRecord {
    mode: String,
    actions: Vec<(String, persistence::Action)>,
    phrase: String,
    created: Instant,
    used: bool,
}

pub struct AppState {
    pub store: Store,
    home: String,
    config: ProtectedConfig,
    entries: Vec<PersistenceEntry>,
    kill_plans: HashMap<String, KillPlanRecord>,
    persist_plans: HashMap<String, PersistPlanRecord>,
    counter: u64,
}

impl AppState {
    pub fn new() -> Self {
        let base = data_dir();
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_default();
        Self {
            store: Store::new(base.join("manifests")),
            home,
            config: load_config(),
            entries: Vec::new(),
            kill_plans: HashMap::new(),
            persist_plans: HashMap::new(),
            counter: 0,
        }
    }

    fn next_id(&mut self, prefix: &str) -> String {
        self.counter += 1;
        format!("{prefix}{:x}{:x}", self.counter, nanos())
    }

    fn ancestry(&self, procs: &[Process]) -> Vec<u32> {
        let by: HashMap<u32, &Process> = procs.iter().map(|p| (p.pid, p)).collect();
        let mut chain = Vec::new();
        let mut cur = std::process::id();
        for _ in 0..30 {
            let Some(p) = by.get(&cur) else { break };
            chain.push(cur);
            cur = p.ppid;
        }
        chain
    }

    fn kill_opts(&self, procs: &[Process], include_tree: bool) -> guard::KillOptions {
        guard::KillOptions {
            include_tree,
            protected_pids: self.ancestry(procs),
            self_pid: Some(std::process::id()),
            config: self.config.clone(),
        }
    }

    pub fn snapshot(&mut self) -> Result<serde_json::Value, String> {
        let snap = collect::snapshot();
        let a = attribute::attribute(&snap.processes, &self.home);
        let total_gb = snap.total_mem_kb as f64 / 1_048_576.0;
        let free_gb = snap.free_mem_kb as f64 / 1_048_576.0;

        Ok(serde_json::json!({
            "ts": now_iso(),
            "engine": "rust",
            "readOnly": false,
            "version": env!("CARGO_PKG_VERSION"),
            "system": {
                "totalGB": round1(total_gb),
                "freeGB": round1(free_gb),
                "usedGB": round1(total_gb - free_gb),
                "cpus": snap.cpus,
                "procCount": snap.processes.len(),
            },
            "processes": a.processes,
            "owners": a.owners,
            "fanout": a.fanout,
            "ports": snap.ports,
            "counts": {
                "processes": snap.processes.len(),
                "owners": a.owners.len(),
                "ports": snap.ports.len(),
            },
        }))
    }

    // ---- kill ----

    pub fn plan_kill(&mut self, pids: &[u32], include_tree: bool) -> Result<serde_json::Value, String> {
        let procs = collect::processes();
        let opts = self.kill_opts(&procs, include_tree);
        let v = guard::evaluate_kill(pids, &procs, &opts);

        let est: f64 = v.allowed.iter().filter_map(|x| x.mem_mb).sum();
        let phrase = format!("PARK {}", v.allowed.len());
        let id = self.next_id("k");
        self.kill_plans.insert(
            id.clone(),
            KillPlanRecord {
                pids: pids.to_vec(),
                include_tree,
                allowed_pids: v.allowed.iter().map(|x| x.pid).collect(),
                phrase: phrase.clone(),
                created: Instant::now(),
                used: false,
            },
        );
        self.kill_plans.retain(|_, p| p.created.elapsed() < PLAN_TTL);

        Ok(serde_json::json!({
            "planId": id,
            "confirmPhrase": phrase,
            "expiresInSec": PLAN_TTL.as_secs(),
            "estimateMB": est.round(),
            "allowed": v.allowed,
            "blocked": v.blocked,
        }))
    }

    pub fn execute_kill(&mut self, plan_id: &str, confirm: &str) -> Result<serde_json::Value, String> {
        let (pids, include_tree, allowed_pids) = {
            let p = self.kill_plans.get_mut(plan_id)
                .ok_or("unknown or expired plan — run the dry run again")?;
            if p.used { return Err("plan already executed".into()); }
            if p.created.elapsed() >= PLAN_TTL { return Err("plan expired".into()); }
            if confirm != p.phrase {
                return Err(format!("confirmation mismatch — type exactly: {}", p.phrase));
            }
            p.used = true;
            (p.pids.clone(), p.include_tree, p.allowed_pids.clone())
        };

        // Gate 3: re-evaluate against a fresh table. A plan is a proposal.
        let procs = collect::processes();
        let opts = self.kill_opts(&procs, include_tree);
        let v = guard::evaluate_kill(&pids, &procs, &opts);

        let victims: Vec<Victim> = v.allowed.iter()
            .filter(|x| allowed_pids.contains(&x.pid))
            .map(|x| {
                let full = procs.iter().find(|p| p.pid == x.pid);
                let path = full.and_then(|p| p.path.clone());
                let cmd = full.and_then(|p| p.cmd.clone()).or_else(|| x.cmd.clone());
                Victim {
                    pid: Some(x.pid),
                    name: x.name.clone(),
                    mem_mb: x.mem_mb,
                    restorable: hangar_core::manifest::is_restorable(&x.name, &path, &cmd),
                    cmd, path, ports: vec![], persistence: None,
                }
            })
            .collect();

        if victims.is_empty() {
            return Ok(serde_json::json!({
                "killed": [], "skipped": v.blocked,
                "note": "nothing left to kill — processes changed since the plan"
            }));
        }

        // Manifest BEFORE the first kill. If this fails, nothing dies.
        let m = self.store
            .write("park", victims.clone(), serde_json::json!({ "confirmPhrase": confirm }))
            .map_err(|e| format!("manifest write failed, nothing was killed: {e}"))?;

        let mut killed = Vec::new();
        let mut failed = Vec::new();
        for vic in &victims {
            match executor::kill(vic.pid.unwrap_or(0)) {
                Ok(_) => killed.push(vic.clone()),
                Err(e) => failed.push(serde_json::json!({ "pid": vic.pid, "name": vic.name, "error": e })),
            }
        }

        let freed: f64 = killed.iter().filter_map(|v| v.mem_mb).sum();
        Ok(serde_json::json!({
            "manifestId": m.id,
            "killed": killed,
            "failed": failed,
            "blocked": v.blocked,
            "freedEstimateMB": freed.round(),
        }))
    }

    // ---- persistence ----

    pub fn set_entries(&mut self, entries: Vec<PersistenceEntry>) {
        self.entries = entries;
    }

    pub fn plan_persistence(&mut self, ids: &[String], mode: &str) -> Result<serde_json::Value, String> {
        let disable = mode != "enable";
        let v = if disable {
            persistence::evaluate_persistence(ids, &self.entries, &self.config)
        } else {
            // Re-enabling only ever restores prior state, so it is not gated
            // on the protect lists — but it still needs a confirmation.
            let allowed = ids.iter().filter_map(|id| {
                self.entries.iter().find(|e| &e.id() == id).map(|e| persistence::EntryVerdict {
                    id: id.clone(),
                    name: e.display.clone().unwrap_or_else(|| e.name.clone()),
                    kind: e.kind.clone(),
                    command: e.command.clone(),
                    location: e.location.clone(),
                    added: e.added.clone(),
                    action: Some(persistence::describe_action(e, false)),
                    reason: None,
                })
            }).collect();
            persistence::PersistencePlan { allowed, blocked: vec![] }
        };

        let needs_admin = v.allowed.iter()
            .filter(|a| a.action.as_ref().is_some_and(|x| x.needs_admin))
            .count();
        let phrase = format!("{} {}", if disable { "DISABLE" } else { "ENABLE" }, v.allowed.len());
        let id = self.next_id("p");

        self.persist_plans.insert(id.clone(), PersistPlanRecord {
            mode: mode.to_string(),
            actions: v.allowed.iter()
                .filter_map(|a| a.action.clone().map(|act| (a.id.clone(), act)))
                .collect(),
            phrase: phrase.clone(),
            created: Instant::now(),
            used: false,
        });
        self.persist_plans.retain(|_, p| p.created.elapsed() < PLAN_TTL);

        Ok(serde_json::json!({
            "planId": id,
            "mode": mode,
            "confirmPhrase": phrase,
            "allowed": v.allowed,
            "blocked": v.blocked,
            "adminRequired": needs_admin,
            "adminNote": if needs_admin > 0 {
                serde_json::Value::String(format!(
                    "{needs_admin} of these need an elevated agent (HKLM keys and services). \
                     They will be reported as skipped, not silently failed."))
            } else { serde_json::Value::Null },
        }))
    }

    pub fn execute_persistence(&mut self, plan_id: &str, confirm: &str) -> Result<serde_json::Value, String> {
        let (mode, actions) = {
            let p = self.persist_plans.get_mut(plan_id)
                .ok_or("unknown or expired plan — run the dry run again")?;
            if p.used { return Err("plan already executed".into()); }
            if p.created.elapsed() >= PLAN_TTL { return Err("plan expired".into()); }
            if confirm != p.phrase {
                return Err(format!("confirmation mismatch — type exactly: {}", p.phrase));
            }
            p.used = true;
            (p.mode.clone(), p.actions.clone())
        };

        if actions.is_empty() {
            return Ok(serde_json::json!({ "applied": [], "note": "nothing to do" }));
        }

        // The action block is what makes an undo executable later, when the
        // entry itself has vanished from the collector.
        let victims: Vec<Victim> = actions.iter().map(|(id, a)| Victim {
            pid: None, name: id.clone(), mem_mb: None,
            cmd: Some(a.summary.clone()), path: None, ports: vec![],
            persistence: Some(a.clone()), restorable: true,
        }).collect();

        let m = self.store
            .write(&format!("persist-{mode}"), victims, serde_json::json!({ "confirmPhrase": confirm, "mode": mode }))
            .map_err(|e| format!("manifest write failed, nothing was changed: {e}"))?;

        let elevated = executor::is_elevated();
        let results: Vec<_> = actions.iter()
            .map(|(id, a)| executor::apply_action(id, a, elevated))
            .collect();
        let failed = results.iter().filter(|r| !r.ok).count();

        Ok(serde_json::json!({
            "manifestId": m.id,
            "mode": mode,
            "elevated": elevated,
            "applied": results.iter().filter(|r| r.ok).collect::<Vec<_>>(),
            "failed": results.iter().filter(|r| !r.ok).collect::<Vec<_>>(),
            "note": if failed > 0 && !elevated {
                serde_json::Value::String(
                    "Some entries need an Administrator agent. Restart Hangar elevated and re-run those.".into())
            } else { serde_json::Value::Null },
        }))
    }

    pub fn restore(&mut self, manifest_id: &str) -> Result<serde_json::Value, String> {
        let m = self.store.get(manifest_id).ok_or("manifest not found")?;

        if m.action.starts_with("persist-") {
            let elevated = executor::is_elevated();
            let results: Vec<_> = m.victims.iter()
                .filter_map(|v| v.persistence.as_ref().map(|a| (v.name.clone(), a)))
                .filter_map(|(id, a)| persistence::invert_action(a).map(|inv| (id, inv)))
                .map(|(id, inv)| executor::apply_action(&id, &inv, elevated))
                .collect();
            if results.is_empty() {
                return Err("this manifest predates persistence-action recording and cannot be auto-restored".into());
            }
            let ok = results.iter().all(|r| r.ok);
            self.store.mark_restored(manifest_id, serde_json::to_value(&results).unwrap_or_default());
            return Ok(serde_json::json!({ "ok": ok, "kind": "persistence", "elevated": elevated, "results": results }));
        }

        // Process manifest: relaunch each recorded executable directly.
        let mut results = Vec::new();
        for v in &m.victims {
            if !v.restorable {
                results.push(serde_json::json!({
                    "name": v.name, "ok": false,
                    "why": "OS-managed helper or no usable command recorded"
                }));
                continue;
            }
            let argv = v.cmd.as_deref().map(hangar_core::manifest::split_argv).unwrap_or_default();
            let exe = v.path.clone().or_else(|| argv.first().cloned());
            match exe {
                Some(e) => match executor::relaunch(&e, v.cmd.as_deref()) {
                    Ok(pid) => results.push(serde_json::json!({ "name": v.name, "ok": true, "newPid": pid })),
                    Err(err) => results.push(serde_json::json!({ "name": v.name, "ok": false, "why": err })),
                },
                None => results.push(serde_json::json!({ "name": v.name, "ok": false, "why": "no executable resolved" })),
            }
        }
        self.store.mark_restored(manifest_id, serde_json::Value::Array(results.clone()));
        Ok(serde_json::json!({ "ok": true, "kind": "process", "results": results }))
    }
}

fn data_dir() -> std::path::PathBuf {
    std::env::var("HANGAR_DATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            let base = std::env::var("APPDATA")
                .or_else(|_| std::env::var("HOME"))
                .unwrap_or_else(|_| ".".into());
            std::path::Path::new(&base).join("Hangar")
        })
}

fn load_config() -> ProtectedConfig {
    let f = data_dir().join("protected.json");
    std::fs::read_to_string(f)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(ProtectedConfig::defaults)
}

fn nanos() -> u32 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0)
}

fn now_iso() -> String {
    format!("epoch:{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0))
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}
