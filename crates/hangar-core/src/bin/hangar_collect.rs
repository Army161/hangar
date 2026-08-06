//! `hangar-collect` — emits the same JSON shape as `scripts/collect-fast.ps1`.
//!
//! This is what makes the differential harness possible: run both stacks
//! against the same live machine and diff owners, rootPids, and verdicts.
//! Zero diffs is the M2 acceptance gate.
//!
//! Usage:
//!   hangar-collect            full snapshot (processes, ports, owners, fanout)
//!   hangar-collect --bench    timing only, for the <100ms gate

use hangar_core::{attribute, collect};
use std::time::Instant;

fn main() {
    let bench = std::env::args().any(|a| a == "--bench");
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();

    let t0 = Instant::now();
    let snap = collect::snapshot();
    let t_collect = t0.elapsed();

    let t1 = Instant::now();
    let attributed = attribute::attribute(&snap.processes, &home);
    let t_attribute = t1.elapsed();

    if bench {
        println!(
            "{}",
            serde_json::json!({
                "processes":   snap.processes.len(),
                "ports":       snap.ports.len(),
                "owners":      attributed.owners.len(),
                "collectMs":   t_collect.as_secs_f64() * 1000.0,
                "attributeMs": t_attribute.as_secs_f64() * 1000.0,
                "totalMs":     t0.elapsed().as_secs_f64() * 1000.0,
            })
        );
        return;
    }

    let used_gb = (snap.total_mem_kb.saturating_sub(snap.free_mem_kb)) as f64 / 1_048_576.0;
    let out = serde_json::json!({
        "ts": chrono_now(),
        "engine": "rust",
        "system": {
            "totalGB":   (snap.total_mem_kb as f64 / 1_048_576.0 * 10.0).round() / 10.0,
            "freeGB":    (snap.free_mem_kb  as f64 / 1_048_576.0 * 10.0).round() / 10.0,
            "usedGB":    (used_gb * 10.0).round() / 10.0,
            "cpus":      snap.cpus,
            "procCount": snap.processes.len(),
        },
        "timings": {
            "collectMs":   t_collect.as_secs_f64() * 1000.0,
            "attributeMs": t_attribute.as_secs_f64() * 1000.0,
        },
        "processes": attributed.processes,
        "owners":    attributed.owners,
        "fanout":    attributed.fanout,
        "ports":     snap.ports,
    });
    println!("{}", serde_json::to_string(&out).unwrap());
}

/// Minimal ISO-8601 stamp without pulling in a date crate for one line.
fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("epoch:{secs}")
}
