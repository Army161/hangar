//! Shared types.
//!
//! Field names match the JSON the Node stack already emits, so the Rust
//! collector is a drop-in replacement and the differential harness can diff
//! the two payloads directly.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Process {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
    #[serde(rename = "memMB")]
    pub mem_mb: f64,
    #[serde(default, rename = "cpuSec")]
    pub cpu_sec: f64,
    #[serde(default, rename = "cpuPct")]
    pub cpu_pct: Option<f64>,
    #[serde(default)]
    pub started: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub cmd: Option<String>,
}

impl Process {
    /// Everything a signature or guard rule is matched against.
    pub fn haystack(&self) -> String {
        format!(
            "{} {} {}",
            self.cmd.as_deref().unwrap_or(""),
            self.path.as_deref().unwrap_or(""),
            self.name
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortRow {
    pub port: u16,
    #[serde(default)]
    pub addr: String,
    pub pid: u32,
}

/// A process decorated with its resolved owner.
#[derive(Debug, Clone, Serialize)]
pub struct Attributed {
    #[serde(flatten)]
    pub proc: Process,
    pub owner: String,
    pub kind: String,
    pub vendor: Option<String>,
    #[serde(rename = "ownerPid")]
    pub owner_pid: u32,
    pub inherited: bool,
    pub confidence: String,
    pub reattach: bool,
    #[serde(rename = "projectPath")]
    pub project_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OwnerGroup {
    pub key: String,
    pub owner: String,
    pub kind: String,
    pub vendor: Option<String>,
    pub procs: usize,
    #[serde(rename = "memMB")]
    pub mem_mb: f64,
    #[serde(rename = "cpuSec")]
    pub cpu_sec: f64,
    pub pids: Vec<u32>,
    #[serde(rename = "rootPids")]
    pub root_pids: Vec<u32>,
    pub reattach: bool,
    #[serde(rename = "projectPath")]
    pub project_path: Option<String>,
    pub oldest: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FanoutRow {
    pub owner: String,
    pub kind: String,
    pub vendor: Option<String>,
    pub copies: usize,
    pub procs: usize,
    #[serde(rename = "memMB")]
    pub mem_mb: f64,
    #[serde(rename = "reclaimMB")]
    pub reclaim_mb: f64,
}

/// One process's verdict from the kill guard.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Verdict {
    pub pid: u32,
    pub name: String,
    #[serde(rename = "memMB")]
    pub mem_mb: Option<f64>,
    pub cmd: Option<String>,
    /// `None` means allowed. `Some(reason)` means blocked, and the reason is
    /// always shown to the user — a silent block is as bad as a silent kill.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct KillPlan {
    pub allowed: Vec<Verdict>,
    pub blocked: Vec<Verdict>,
    pub expanded: Vec<u32>,
}

/// User-editable protections. Mirrors config/protected.json exactly.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct ProtectedConfig {
    #[serde(default)]
    pub names: Vec<String>,
    #[serde(default)]
    pub projects: Vec<String>,
}

impl ProtectedConfig {
    pub fn defaults() -> Self {
        Self {
            names: [
                "ollama",
                "ollama app",
                "llama-server",
                "terminal64",
                "OneDrive",
                "SignalRgb",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect(),
            projects: ["TAO_WALLET", "OUROBOROS"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PersistenceEntry {
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub display: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub added: Option<String>,
    #[serde(default, rename = "addedSource")]
    pub added_source: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default, rename = "startMode")]
    pub start_mode: Option<String>,
    #[serde(default, rename = "svcPid")]
    pub svc_pid: Option<u32>,
}

impl PersistenceEntry {
    /// Stable identifier across snapshots. Must match lib/persistence.js.
    pub fn id(&self) -> String {
        format!(
            "{}::{}::{}",
            self.kind,
            self.location.as_deref().unwrap_or(""),
            self.name
        )
    }

    pub fn is_disabled(&self) -> bool {
        self.enabled == Some(false) || self.state.as_deref() == Some("Disabled")
    }
}
