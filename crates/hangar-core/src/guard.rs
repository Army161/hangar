//! Kill guard — Rust port of `lib/guard.js`.
//!
//! Invariants carried over verbatim, because they were written in response to
//! a real incident (2026-07-29, a protected MetaTrader terminal killed via
//! tree expansion):
//!
//!   1. `evaluate_kill` is pure. It returns verdicts; it never logs, never
//!      mutates. The original bug was a log statement inside a PowerShell
//!      `Where-Object` block polluting the pipeline so blocked items passed.
//!   2. Protection is evaluated AFTER tree expansion, on the final pid list.
//!      A killable parent never launders its protected children.
//!   3. Every requested pid lands in exactly one bucket. Silent drops are bugs.
//!   4. When in doubt, block.

use crate::types::{KillPlan, ProtectedConfig, Process, Verdict};
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

/// System-critical. Killing these can take down the session or the OS.
/// This list is code, not config — it is not overridable from protected.json.
fn system_deny() -> &'static Vec<Regex> {
    static R: OnceLock<Vec<Regex>> = OnceLock::new();
    R.get_or_init(|| {
        [
            r"(?i)^System(\s|$)",
            r"(?i)^Registry$",
            r"(?i)^Memory Compression$",
            r"(?i)^smss\.exe$",
            r"(?i)^csrss\.exe$",
            r"(?i)^wininit\.exe$",
            r"(?i)^winlogon\.exe$",
            r"(?i)^services\.exe$",
            r"(?i)^lsass\.exe$",
            r"(?i)^svchost\.exe$",
            r"(?i)^dwm\.exe$",
            r"(?i)^fontdrvhost\.exe$",
            r"(?i)^MsMpEng\.exe$",
            r"(?i)^MpDefender",
            r"(?i)^SecurityHealth",
            r"(?i)^explorer\.exe$",
            r"(?i)^NVDisplay",
            r"(?i)^nvcontainer",
            r"(?i)^wslservice\.exe$",
        ]
        .iter()
        .map(|p| Regex::new(p).expect("static guard pattern"))
        .collect()
    })
}

fn hangar_self() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)hangar[\\/](server\.js|hangar-collect)").unwrap())
}

pub struct KillOptions {
    pub include_tree: bool,
    /// This session's ancestry chain — the agent must never kill its own host.
    pub protected_pids: Vec<u32>,
    pub self_pid: Option<u32>,
    pub config: ProtectedConfig,
}

impl Default for KillOptions {
    fn default() -> Self {
        Self {
            include_tree: false,
            protected_pids: Vec::new(),
            self_pid: None,
            config: ProtectedConfig::defaults(),
        }
    }
}

fn escape(s: &str) -> String {
    regex::escape(s)
}

/// Expand requested pids to full descendant trees.
pub fn expand_trees(
    pids: &[u32],
    by_pid: &HashMap<u32, &Process>,
    kids: &HashMap<u32, Vec<u32>>,
) -> HashSet<u32> {
    let mut out = HashSet::new();
    let mut stack: Vec<u32> = pids.to_vec();
    while let Some(cur) = stack.pop() {
        if out.contains(&cur) || !by_pid.contains_key(&cur) {
            continue;
        }
        out.insert(cur);
        if let Some(children) = kids.get(&cur) {
            stack.extend(children.iter().copied());
        }
    }
    out
}

pub fn evaluate_kill(requested: &[u32], processes: &[Process], opts: &KillOptions) -> KillPlan {
    let mut by_pid: HashMap<u32, &Process> = HashMap::with_capacity(processes.len());
    let mut kids: HashMap<u32, Vec<u32>> = HashMap::new();
    for p in processes {
        by_pid.insert(p.pid, p);
        kids.entry(p.ppid).or_default().push(p.pid);
    }

    let mut protected: HashSet<u32> = opts.protected_pids.iter().copied().collect();
    if let Some(sp) = opts.self_pid {
        protected.insert(sp);
    }
    protected.insert(std::process::id());

    let name_deny: Vec<Regex> = opts
        .config
        .names
        .iter()
        .filter_map(|n| Regex::new(&format!("(?i)^{}", escape(n))).ok())
        .collect();
    let project_deny: Vec<Regex> = opts
        .config
        .projects
        .iter()
        .filter_map(|n| Regex::new(&format!("(?i){}", escape(n))).ok())
        .collect();

    let final_pids: HashSet<u32> = if opts.include_tree {
        expand_trees(requested, &by_pid, &kids)
    } else {
        requested
            .iter()
            .copied()
            .filter(|p| by_pid.contains_key(p))
            .collect()
    };

    let mut allowed = Vec::new();
    let mut blocked = Vec::new();

    for pid in &final_pids {
        let p = by_pid[pid];
        let hay = format!(
            "{} {}",
            p.cmd.as_deref().unwrap_or(""),
            p.path.as_deref().unwrap_or("")
        );

        // Order matters and mirrors the JS exactly.
        let reason: Option<String> = if opts.self_pid == Some(*pid)
            || p.cmd.as_deref().map(|c| hangar_self().is_match(c)).unwrap_or(false)
        {
            Some("protected: the hangar agent itself".into())
        } else if protected.contains(pid) {
            Some("protected: this session\u{2019}s own process chain".into())
        } else if system_deny().iter().any(|re| re.is_match(&p.name)) {
            Some("protected: system-critical process".into())
        } else if name_deny.iter().any(|re| re.is_match(&p.name)) {
            Some("protected: on your protected-apps list (config/protected.json)".into())
        } else if project_deny.iter().any(|re| re.is_match(&hay)) {
            Some("protected: belongs to a protected project (config/protected.json)".into())
        } else {
            None
        };

        let v = Verdict {
            pid: *pid,
            name: p.name.clone(),
            mem_mb: Some(p.mem_mb),
            cmd: p.cmd.clone(),
            reason: reason.clone(),
        };
        if reason.is_some() {
            blocked.push(v);
        } else {
            allowed.push(v);
        }
    }

    allowed.sort_by_key(|v| v.pid);
    blocked.sort_by_key(|v| v.pid);
    let mut expanded: Vec<u32> = final_pids.into_iter().collect();
    expanded.sort_unstable();

    KillPlan {
        allowed,
        blocked,
        expanded,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The 2026-07-29 layout, reproduced from test/guard.test.js.
    fn mt5_scenario() -> Vec<Process> {
        let mk = |pid, ppid, name: &str, cmd: &str| Process {
            pid,
            ppid,
            name: name.into(),
            mem_mb: 10.0,
            cmd: Some(cmd.into()),
            ..Default::default()
        };
        vec![
            mk(68340, 36824, "pwsh.exe", "pwsh -NoProfile"),
            mk(36824, 24248, "claude.exe", "claude renderer"),
            mk(24248, 10268, "claude.exe", "claude main"),
            mk(10268, 10216, "explorer.exe", "explorer"),
            mk(11380, 4444, "python.exe",
               r"python C:\Users\Armyg\metatrader5-tradingbot\dashboard\server.py"),
            // terminal64 is a CHILD of the dashboard — this is the trap.
            mk(41660, 11380, "terminal64.exe",
               r#""C:\Program Files\MetaTrader 5\terminal64.exe""#),
            mk(46456, 4444, "bun.exe", r"C:\Users\Armyg\.bun\bin\bun.exe server.ts"),
            mk(33333, 4444, "python.exe", r"python C:\Users\Armyg\TAO_WALLET\tao_alerts.py"),
            mk(44444, 4444, "node.exe", r"node C:\Users\Armyg\OUROBOROS\loop.js"),
            mk(4, 0, "System", ""),
            mk(555, 4, "svchost.exe", "svchost -k netsvcs"),
            mk(4812, 555, "MsMpEng.exe", ""),
            mk(29768, 10268, "ollama.exe", "ollama serve"),
        ]
    }

    fn opts(include_tree: bool) -> KillOptions {
        KillOptions {
            include_tree,
            protected_pids: vec![68340, 36824, 24248, 10268],
            self_pid: Some(99999),
            config: ProtectedConfig::defaults(),
        }
    }

    #[test]
    fn mt5_regression_terminal64_blocked_via_tree_expansion() {
        let procs = mt5_scenario();
        let v = evaluate_kill(&[11380], &procs, &opts(true));
        assert!(
            v.blocked.iter().any(|b| b.pid == 41660),
            "terminal64.exe must be blocked"
        );
        assert!(
            !v.allowed.iter().any(|a| a.pid == 41660),
            "terminal64.exe must not be allowed"
        );
        assert!(v.allowed.iter().any(|a| a.pid == 11380), "dashboard is killable");
        let t = v.blocked.iter().find(|b| b.pid == 41660).unwrap();
        assert!(t.reason.as_ref().unwrap().to_lowercase().contains("protected"));
    }

    #[test]
    fn every_requested_pid_lands_in_exactly_one_bucket() {
        let procs = mt5_scenario();
        let req = [11380u32, 46456, 4812, 29768];
        let v = evaluate_kill(&req, &procs, &opts(true));
        let mut all: Vec<u32> = v
            .allowed
            .iter()
            .chain(v.blocked.iter())
            .map(|x| x.pid)
            .collect();
        all.sort_unstable();
        let uniq: HashSet<u32> = all.iter().copied().collect();
        assert_eq!(all.len(), uniq.len(), "no pid may appear twice");
        let expected: HashSet<u32> = [11380u32, 46456, 4812, 29768, 41660].into_iter().collect();
        assert_eq!(uniq, expected, "every expanded pid is accounted for");
    }

    #[test]
    fn deny_list_blocks_system_defender_and_ollama() {
        let v = evaluate_kill(&[4, 555, 4812, 29768], &mt5_scenario(), &opts(false));
        assert_eq!(v.allowed.len(), 0);
        assert_eq!(v.blocked.len(), 4);
    }

    #[test]
    fn protected_chain_blocks_own_session_even_when_requested_directly() {
        let v = evaluate_kill(&[24248, 36824], &mt5_scenario(), &opts(false));
        assert_eq!(v.allowed.len(), 0);
        for b in &v.blocked {
            let r = b.reason.as_ref().unwrap().to_lowercase();
            assert!(r.contains("session") || r.contains("chain"));
        }
    }

    #[test]
    fn protected_projects_block_by_command_line() {
        let v = evaluate_kill(&[33333, 44444], &mt5_scenario(), &opts(false));
        assert_eq!(v.allowed.len(), 0);
        assert_eq!(v.blocked.len(), 2);
    }

    #[test]
    fn tree_expansion_cannot_smuggle_a_protected_pid_into_allowed() {
        let mut procs = mt5_scenario();
        procs.push(Process {
            pid: 4444,
            ppid: 10216,
            name: "cmd.exe".into(),
            mem_mb: 8.0,
            cmd: Some("cmd /c stuff".into()),
            ..Default::default()
        });
        let v = evaluate_kill(&[4444], &procs, &opts(true));
        let allowed: HashSet<u32> = v.allowed.iter().map(|a| a.pid).collect();
        assert!(!allowed.contains(&41660), "terminal64 blocked via deep expansion");
        assert!(!allowed.contains(&33333), "TAO blocked via deep expansion");
        assert!(
            v.blocked.iter().any(|b| b.pid == 44444),
            "OUROBOROS process must be blocked"
        );
    }

    #[test]
    fn guard_protects_the_hangar_agent_itself() {
        let mut procs = mt5_scenario();
        procs.push(Process {
            pid: 7777,
            ppid: 4444,
            name: "node.exe".into(),
            mem_mb: 80.0,
            cmd: Some("node hangar/server.js".into()),
            ..Default::default()
        });
        let mut o = opts(false);
        o.self_pid = Some(7777);
        let v = evaluate_kill(&[7777], &procs, &o);
        assert_eq!(v.allowed.len(), 0);
        assert!(v.blocked[0].reason.as_ref().unwrap().to_lowercase().contains("hangar"));
    }

    #[test]
    fn a_dead_pid_is_dropped_rather_than_invented() {
        let v = evaluate_kill(&[999_999], &mt5_scenario(), &opts(true));
        assert_eq!(v.allowed.len(), 0);
        assert_eq!(v.blocked.len(), 0);
        assert!(v.expanded.is_empty());
    }
}
