//! Persistence control — Rust port of `lib/persistence.js`.
//!
//! Pure logic only: which entries may be disabled, what the action literally
//! is, and how to invert it. Execution lives in the executor.
//!
//! NOTHING described here deletes anything. Startup files move to quarantine,
//! registry values are recorded before removal, tasks and services keep their
//! definitions. `no_action_is_destructive` asserts that in both directions.

use crate::types::{PersistenceEntry, ProtectedConfig};
use regex::Regex;
use serde::Serialize;
use std::sync::OnceLock;

fn security() -> &'static Vec<Regex> {
    static R: OnceLock<Vec<Regex>> = OnceLock::new();
    R.get_or_init(|| {
        [
            r"(?i)^SecurityHealth", r"(?i)^WinDefend$", r"(?i)^MDCoreSvc$", r"(?i)^Sense$",
            r"(?i)^wscsvc$", r"(?i)^MsMpEng", r"(?i)Defender", r"(?i)^SgrmBroker$",
        ].iter().map(|p| Regex::new(p).unwrap()).collect()
    })
}

fn core_services() -> &'static Vec<Regex> {
    static R: OnceLock<Vec<Regex>> = OnceLock::new();
    R.get_or_init(|| {
        [
            r"(?i)^WSLService$", r"(?i)^LxssManager$", r"(?i)^Winmgmt$", r"(?i)^RpcSs$",
            r"(?i)^Dhcp$", r"(?i)^Dnscache$", r"(?i)^EventLog$", r"(?i)^Schedule$",
            r"(?i)^BFE$", r"(?i)^mpssvc$", r"(?i)^CryptSvc$", r"(?i)^TrustedInstaller$",
            r"(?i)^wuauserv$", r"(?i)^ClickToRunSvc$", r"(?i)^NvContainer", r"(?i)^nvagent$",
            r"(?i)^AudioSrv", r"(?i)^Audiosrv$",
        ].iter().map(|p| Regex::new(p).unwrap()).collect()
    })
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Action {
    pub op: String,
    pub summary: String,
    pub destructive: bool,
    #[serde(rename = "needsAdmin")]
    pub needs_admin: bool,
    #[serde(skip_serializing_if = "Option::is_none")] pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub hive: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "valueName")] pub value_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "recordedValue")] pub recorded_value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "taskName")] pub task_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "taskPath")] pub task_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "serviceName")] pub service_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub previous: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub command: Option<String>,
}

impl Default for Action {
    fn default() -> Self {
        Self {
            op: "unsupported".into(), summary: String::new(), destructive: false, needs_admin: false,
            from: None, to: None, hive: None, value_name: None, recorded_value: None,
            task_name: None, task_path: None, service_name: None, previous: None, target: None,
            command: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct EntryVerdict {
    pub id: String,
    pub name: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")] pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub added: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub action: Option<Action>,
    #[serde(skip_serializing_if = "Option::is_none")] pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct PersistencePlan {
    pub allowed: Vec<EntryVerdict>,
    pub blocked: Vec<EntryVerdict>,
}

fn quarantine_dir() -> String {
    std::env::var("HANGAR_QUARANTINE").unwrap_or_else(|_| "quarantine".into())
}

fn basename(p: &str) -> &str {
    p.rsplit(['\\', '/']).next().unwrap_or(p)
}

pub fn describe_action(entry: &PersistenceEntry, disable: bool) -> Action {
    match entry.kind.as_str() {
        "startup-folder" => {
            let file = entry.target.clone().or_else(|| entry.command.clone()).unwrap_or_default();
            let base = basename(&file).to_string();
            let parked = format!("{}\\startup\\{}", quarantine_dir(), base);
            Action {
                op: "move-file".into(),
                from: Some(if disable { file.clone() } else { parked.clone() }),
                to: Some(if disable { parked } else { file.clone() }),
                destructive: false,
                needs_admin: Regex::new(r"(?i)ProgramData").unwrap().is_match(&file),
                summary: if disable {
                    format!("Move {} out of Startup into quarantine", base)
                } else {
                    format!("Move {} back into Startup", base)
                },
                ..Default::default()
            }
        }
        "registry-run" => {
            let loc = entry.location.clone().unwrap_or_default();
            let hklm = loc.to_uppercase().starts_with("HKLM");
            Action {
                op: if disable { "registry-remove-value".into() } else { "registry-restore-value".into() },
                hive: Some(loc.clone()),
                value_name: Some(entry.name.clone()),
                // Recording the exact value is what makes removal reversible.
                recorded_value: entry.command.clone(),
                destructive: false,
                needs_admin: hklm,
                summary: if disable {
                    format!("Remove Run value \"{}\" from {} (value recorded)", entry.name, loc)
                } else {
                    format!("Recreate Run value \"{}\" in {}", entry.name, loc)
                },
                ..Default::default()
            }
        }
        "scheduled-task" => {
            let tp = entry.location.clone().unwrap_or_else(|| "\\".into());
            let verb = if disable { "Disable-ScheduledTask" } else { "Enable-ScheduledTask" };
            Action {
                op: if disable { "task-disable".into() } else { "task-enable".into() },
                task_name: Some(entry.name.clone()),
                task_path: Some(tp.clone()),
                command: Some(format!("{} -TaskName '{}' -TaskPath '{}'", verb, entry.name, tp)),
                destructive: false,
                needs_admin: Regex::new(r"(?i)^\\Microsoft\\").unwrap().is_match(&tp),
                summary: if disable {
                    format!("Disable scheduled task {} (definition kept)", entry.name)
                } else {
                    format!("Re-enable scheduled task {}", entry.name)
                },
                ..Default::default()
            }
        }
        "service" => {
            let previous = entry.start_mode.clone().unwrap_or_else(|| "Auto".into());
            let target = if disable { "Disabled".to_string() } else { previous.clone() };
            Action {
                op: "service-startuptype".into(),
                service_name: Some(entry.name.clone()),
                previous: Some(previous.clone()),
                target: Some(target.clone()),
                command: Some(format!("Set-Service -Name '{}' -StartupType {}", entry.name, target)),
                destructive: false,
                needs_admin: true,
                summary: if disable {
                    format!("Set service {} StartupType to Disabled (was {})", entry.name, previous)
                } else {
                    format!("Restore service {} StartupType to {}", entry.name, previous)
                },
                ..Default::default()
            }
        }
        other => Action {
            summary: format!("No supported action for kind \"{}\"", other),
            ..Default::default()
        },
    }
}

/// Invert a recorded action so a manifest can be undone.
///
/// Works from the stored action, not a live entry — a disabled entry usually
/// vanishes from the collector entirely (a moved Startup file is no longer in
/// the Startup folder), so the manifest is the only remaining record.
pub fn invert_action(a: &Action) -> Option<Action> {
    match a.op.as_str() {
        "move-file" => Some(Action {
            from: a.to.clone(),
            to: a.from.clone(),
            summary: format!(
                "Move {} back to its original location",
                basename(a.from.as_deref().unwrap_or(""))
            ),
            ..a.clone()
        }),
        "registry-remove-value" => Some(Action {
            op: "registry-restore-value".into(),
            summary: format!(
                "Recreate Run value \"{}\" in {}",
                a.value_name.as_deref().unwrap_or(""), a.hive.as_deref().unwrap_or("")
            ),
            ..a.clone()
        }),
        "registry-restore-value" => Some(Action {
            op: "registry-remove-value".into(),
            summary: format!(
                "Remove Run value \"{}\" from {}",
                a.value_name.as_deref().unwrap_or(""), a.hive.as_deref().unwrap_or("")
            ),
            ..a.clone()
        }),
        "task-disable" => Some(Action {
            op: "task-enable".into(),
            command: Some(format!("Enable-ScheduledTask -TaskName '{}' -TaskPath '{}'",
                a.task_name.as_deref().unwrap_or(""), a.task_path.as_deref().unwrap_or("\\"))),
            summary: format!("Re-enable scheduled task {}", a.task_name.as_deref().unwrap_or("")),
            ..a.clone()
        }),
        "task-enable" => Some(Action {
            op: "task-disable".into(),
            command: Some(format!("Disable-ScheduledTask -TaskName '{}' -TaskPath '{}'",
                a.task_name.as_deref().unwrap_or(""), a.task_path.as_deref().unwrap_or("\\"))),
            summary: format!("Disable scheduled task {}", a.task_name.as_deref().unwrap_or("")),
            ..a.clone()
        }),
        "service-startuptype" => Some(Action {
            previous: a.target.clone(),
            target: a.previous.clone(),
            command: Some(format!("Set-Service -Name '{}' -StartupType {}",
                a.service_name.as_deref().unwrap_or(""), a.previous.as_deref().unwrap_or("Auto"))),
            summary: format!("Restore service {} StartupType to {}",
                a.service_name.as_deref().unwrap_or(""), a.previous.as_deref().unwrap_or("Auto")),
            ..a.clone()
        }),
        _ => None,
    }
}

pub fn evaluate_persistence(
    ids: &[String],
    entries: &[PersistenceEntry],
    config: &ProtectedConfig,
) -> PersistencePlan {
    let name_deny: Vec<Regex> = config.names.iter()
        .filter_map(|n| Regex::new(&format!("(?i)^{}", regex::escape(n))).ok()).collect();
    let project_deny: Vec<Regex> = config.projects.iter()
        .filter_map(|n| Regex::new(&format!("(?i){}", regex::escape(n))).ok()).collect();

    let mut plan = PersistencePlan::default();

    for id in ids {
        let Some(e) = entries.iter().find(|e| &e.id() == id) else {
            plan.blocked.push(EntryVerdict {
                id: id.clone(), name: id.clone(), kind: "unknown".into(),
                command: None, location: None, added: None, action: None,
                reason: Some("not found — the entry list changed since the plan".into()),
            });
            continue;
        };

        let hay = format!("{} {} {} {}", e.name, e.display.as_deref().unwrap_or(""),
            e.command.as_deref().unwrap_or(""), e.target.as_deref().unwrap_or(""));
        let display = e.display.clone().unwrap_or_else(|| e.name.clone());

        let reason = if e.is_disabled() {
            Some("already disabled — nothing to do".to_string())
        } else if security().iter().any(|r| r.is_match(&e.name) || r.is_match(&display)) {
            Some("protected: security software".to_string())
        } else if e.kind == "service" && core_services().iter().any(|r| r.is_match(&e.name)) {
            Some("protected: core system service".to_string())
        } else if project_deny.iter().any(|r| r.is_match(&hay)) {
            Some("protected project (config/protected.json)".to_string())
        } else if name_deny.iter().any(|r| {
            r.is_match(&e.name) || r.is_match(basename(e.target.as_deref().unwrap_or("")))
        }) {
            Some("protected: on your protected-apps list (config/protected.json)".to_string())
        } else {
            None
        };

        let v = EntryVerdict {
            id: id.clone(), name: display, kind: e.kind.clone(),
            command: e.command.clone(), location: e.location.clone(), added: e.added.clone(),
            action: if reason.is_none() { Some(describe_action(e, true)) } else { None },
            reason: reason.clone(),
        };
        if reason.is_some() { plan.blocked.push(v) } else { plan.allowed.push(v) }
    }

    plan.allowed.sort_by(|a, b| a.id.cmp(&b.id));
    plan.blocked.sort_by(|a, b| a.id.cmp(&b.id));
    plan
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(kind: &str, name: &str, location: &str, command: &str, target: &str) -> PersistenceEntry {
        PersistenceEntry {
            kind: kind.into(), name: name.into(),
            location: Some(location.into()), command: Some(command.into()),
            target: Some(target.into()), enabled: Some(true), ..Default::default()
        }
    }

    fn entries() -> Vec<PersistenceEntry> {
        vec![
            e("startup-folder", "Ollama", r"C:\...\Startup", r"...\Ollama.lnk", r"C:\...\Startup\Ollama.lnk"),
            e("startup-folder", "TikTok", r"C:\...\Startup", r"...\TikTok.lnk", r"C:\...\Startup\TikTok.lnk"),
            e("scheduled-task", "TAO Alerts Watchdog", "\\", r#"wscript.exe "C:\Users\Armyg\TAO_WALLET\run_alerts.vbs""#, ""),
            e("scheduled-task", "PredictionArbScan", "\\", r#""C:\Users\Armyg\fable 5\run_scan.bat""#, ""),
            e("registry-run", "SignalRgb", r"HKCU:\Software\Microsoft\Windows\CurrentVersion\Run",
              r#""C:\Users\Armyg\AppData\Local\VortxEngine\SignalRgbLauncher.exe" --silent"#,
              r"C:\...\SignalRgbLauncher.exe"),
            e("registry-run", "SecurityHealth", r"HKLM:\Software\Microsoft\Windows\CurrentVersion\Run",
              r"C:\Windows\system32\SecurityHealthSystray.exe", r"C:\Windows\system32\SecurityHealthSystray.exe"),
            PersistenceEntry { kind: "service".into(), name: "WinDefend".into(),
                display: Some("Microsoft Defender Antivirus Service".into()),
                location: Some("Services".into()), enabled: Some(true), ..Default::default() },
            PersistenceEntry { kind: "service".into(), name: "WSLService".into(),
                display: Some("WSL Service".into()), location: Some("Services".into()),
                enabled: Some(true), ..Default::default() },
            PersistenceEntry { kind: "service".into(), name: "SignalRgb.Service".into(),
                location: Some("Services".into()), enabled: Some(true),
                start_mode: Some("Auto".into()), ..Default::default() },
        ]
    }

    fn cfg() -> ProtectedConfig {
        ProtectedConfig {
            names: vec!["ollama".into(), "terminal64".into(), "OneDrive".into()],
            projects: vec!["TAO_WALLET".into(), "OUROBOROS".into()],
        }
    }

    fn id_of(es: &[PersistenceEntry], name: &str) -> String {
        es.iter().find(|x| x.name == name).unwrap().id()
    }

    #[test]
    fn entry_ids_are_unique_and_stable() {
        let es = entries();
        let ids: Vec<String> = es.iter().map(|e| e.id()).collect();
        let uniq: std::collections::HashSet<&String> = ids.iter().collect();
        assert_eq!(ids.len(), uniq.len());
        assert_eq!(es[0].id(), es[0].clone().id());
    }

    #[test]
    fn protected_apps_and_projects_are_blocked() {
        let es = entries();
        let v = evaluate_persistence(&[id_of(&es, "Ollama")], &es, &cfg());
        assert_eq!(v.allowed.len(), 0);
        assert!(v.blocked[0].reason.as_ref().unwrap().to_lowercase().contains("protected"));

        let v = evaluate_persistence(&[id_of(&es, "TAO Alerts Watchdog")], &es, &cfg());
        assert_eq!(v.allowed.len(), 0);
        assert!(v.blocked[0].reason.as_ref().unwrap().contains("protected project"));
    }

    #[test]
    fn security_and_core_services_are_never_disablable() {
        let es = entries();
        let ids = vec![id_of(&es, "SecurityHealth"), id_of(&es, "WinDefend"), id_of(&es, "WSLService")];
        let v = evaluate_persistence(&ids, &es, &cfg());
        assert_eq!(v.allowed.len(), 0);
        assert_eq!(v.blocked.len(), 3);
    }

    #[test]
    fn ordinary_entries_are_allowed() {
        let es = entries();
        let ids = vec![id_of(&es, "TikTok"), id_of(&es, "SignalRgb"), id_of(&es, "PredictionArbScan")];
        let v = evaluate_persistence(&ids, &es, &cfg());
        assert_eq!(v.allowed.len(), 3);
        assert_eq!(v.blocked.len(), 0);
    }

    #[test]
    fn every_requested_id_lands_in_exactly_one_bucket() {
        let es = entries();
        let ids: Vec<String> = es.iter().map(|e| e.id()).collect();
        let v = evaluate_persistence(&ids, &es, &cfg());
        assert_eq!(v.allowed.len() + v.blocked.len(), ids.len());
    }

    #[test]
    fn unknown_ids_are_reported_not_silently_dropped() {
        let v = evaluate_persistence(&["does::not::exist".into()], &entries(), &cfg());
        assert_eq!(v.blocked.len(), 1);
        assert!(v.blocked[0].reason.as_ref().unwrap().contains("not found"));
    }

    #[test]
    fn already_disabled_entries_are_not_offered_again() {
        let mut es = entries();
        es[1].enabled = Some(false);
        let v = evaluate_persistence(&[es[1].id()], &es, &cfg());
        assert!(v.blocked[0].reason.as_ref().unwrap().contains("already disabled"));
    }

    #[test]
    fn startup_disable_moves_the_file_and_never_deletes() {
        let a = describe_action(&entries()[1], true);
        assert_eq!(a.op, "move-file");
        assert!(a.to.unwrap().contains("quarantine"));
        assert!(!a.destructive);
        assert!(!a.needs_admin);
    }

    #[test]
    fn registry_disable_records_the_value_before_removing_it() {
        let es = entries();
        let sig = es.iter().find(|x| x.name == "SignalRgb").unwrap();
        let a = describe_action(sig, true);
        assert_eq!(a.op, "registry-remove-value");
        assert!(a.recorded_value.unwrap().contains("SignalRgbLauncher.exe"));
        assert!(!a.destructive);
        assert!(!a.needs_admin, "HKCU does not need admin");

        let hklm = es.iter().find(|x| x.name == "SecurityHealth").unwrap();
        assert!(describe_action(hklm, true).needs_admin, "HKLM does");
    }

    #[test]
    fn task_disable_never_unregisters_and_service_never_deletes() {
        let es = entries();
        let t = describe_action(es.iter().find(|x| x.name == "PredictionArbScan").unwrap(), true);
        assert_eq!(t.op, "task-disable");
        let tc = t.command.unwrap();
        assert!(tc.contains("Disable-ScheduledTask"));
        assert!(!tc.contains("Unregister"));

        let s = describe_action(es.iter().find(|x| x.name == "SignalRgb.Service").unwrap(), true);
        assert_eq!(s.op, "service-startuptype");
        assert_eq!(s.previous.as_deref(), Some("Auto"));
        assert!(s.needs_admin);
        let sc = s.command.unwrap();
        assert!(!sc.contains("Remove-Service") && !sc.contains("sc.exe delete"));
    }

    #[test]
    fn invert_action_round_trips_every_op() {
        let es = entries();
        for name in ["TikTok", "SignalRgb", "PredictionArbScan", "SignalRgb.Service"] {
            let entry = es.iter().find(|x| x.name == name).unwrap();
            let fwd = describe_action(entry, true);
            let back = invert_action(&fwd).unwrap_or_else(|| panic!("{name} must invert"));
            let again = invert_action(&back).unwrap();
            assert_eq!(again.op, fwd.op, "{name}: double inversion returns the original op");
            if fwd.op == "move-file" {
                assert_eq!(back.from, fwd.to);
                assert_eq!(back.to, fwd.from);
                assert_eq!(again.from, fwd.from, "file returns to where it started");
            }
            if fwd.op == "service-startuptype" {
                assert_eq!(back.target, fwd.previous, "service returns to its old StartupType");
            }
        }
    }

    #[test]
    fn invert_carries_enough_data_with_no_live_entry_available() {
        let es = entries();
        let fwd = describe_action(es.iter().find(|x| x.name == "SignalRgb").unwrap(), true);
        // Simulate reading it back from a manifest long after the entry vanished.
        let round = serde_json::from_str::<serde_json::Value>(&serde_json::to_string(&fwd).unwrap()).unwrap();
        assert!(round.get("recordedValue").is_some());
        let back = invert_action(&fwd).unwrap();
        assert_eq!(back.op, "registry-restore-value");
        assert!(back.recorded_value.unwrap().contains("SignalRgbLauncher.exe"));
    }

    #[test]
    fn an_action_with_no_op_cannot_be_inverted_into_something_dangerous() {
        assert!(invert_action(&Action::default()).is_none());
    }

    #[test]
    fn no_action_of_any_kind_is_destructive() {
        let bad = Regex::new(r"(?i)Remove-Item|Unregister-|sc\.exe delete|Remove-Service|\bdel\b").unwrap();
        for entry in entries() {
            for disable in [true, false] {
                let a = describe_action(&entry, disable);
                assert!(!a.destructive, "{} must be non-destructive", entry.name);
                if let Some(c) = &a.command {
                    assert!(!bad.is_match(c), "{} produced a destructive command: {c}", entry.name);
                }
            }
        }
    }
}
