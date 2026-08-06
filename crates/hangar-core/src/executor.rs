//! Executor — the only code in hangar-core that changes the machine.
//!
//! Everything here is reached exclusively through a plan that a human has
//! confirmed by typing a phrase. Nothing in this module decides *whether* to
//! act; the guard already did that. Its job is to act faithfully and report
//! honestly, including reporting an elevation failure as a skip rather than
//! letting it look like success.

use crate::manifest::split_argv;
use crate::persistence::Action;
use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
pub struct ActionResult {
    pub id: String,
    pub op: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn ok(id: &str, op: &str, detail: impl Into<String>) -> ActionResult {
    ActionResult { id: id.into(), op: op.into(), ok: true, detail: Some(detail.into()), error: None }
}
fn err(id: &str, op: &str, error: impl Into<String>) -> ActionResult {
    ActionResult { id: id.into(), op: op.into(), ok: false, detail: None, error: Some(error.into()) }
}

/// Terminate a process. The pid must already have been cleared by the guard.
#[cfg(windows)]
pub fn kill(pid: u32) -> Result<(), String> {
    let out = Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(not(windows))]
pub fn kill(pid: u32) -> Result<(), String> {
    Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .map_err(|e| e.to_string())
        .and_then(|s| if s.success() { Ok(()) } else { Err("kill failed".into()) })
}

/// Relaunch a recorded process. Spawns the executable directly — going
/// through `cmd /c` strips the outer quote pair and corrupts paths with
/// spaces, which once made a restore report success while nothing came back.
pub fn relaunch(exe: &str, cmd: Option<&str>) -> Result<u32, String> {
    let argv = cmd.map(split_argv).unwrap_or_default();
    let args: Vec<String> = if argv.len() > 1 { argv[1..].to_vec() } else { Vec::new() };
    let cwd = Path::new(exe).parent().map(|p| p.to_path_buf());

    let mut c = Command::new(exe);
    c.args(&args);
    if let Some(d) = cwd {
        if d.exists() {
            c.current_dir(d);
        }
    }
    c.spawn().map(|child| child.id()).map_err(|e| e.to_string())
}

#[cfg(windows)]
pub fn is_elevated() -> bool {
    // `net session` succeeds only for an administrator. Cheaper than pulling
    // in a Win32 token dependency for one boolean.
    Command::new("net")
        .args(["session"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
pub fn is_elevated() -> bool {
    std::env::var("USER").map(|u| u == "root").unwrap_or(false)
}

fn powershell(script: &str) -> Result<String, String> {
    let out = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Apply one persistence action. Nothing here deletes: files move, registry
/// values are removed only after being recorded in the manifest, tasks and
/// services keep their definitions.
pub fn apply_action(id: &str, a: &Action, elevated: bool) -> ActionResult {
    if a.needs_admin && !elevated {
        return err(id, &a.op, "requires an elevated Hangar agent");
    }

    match a.op.as_str() {
        "move-file" => {
            let (Some(from), Some(to)) = (a.from.as_deref(), a.to.as_deref()) else {
                return err(id, &a.op, "move-file needs both from and to");
            };
            if !Path::new(from).exists() {
                return err(id, &a.op, format!("source not found: {from}"));
            }
            if Path::new(to).exists() {
                return err(id, &a.op, format!("destination already occupied: {to}"));
            }
            if let Some(parent) = Path::new(to).parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    return err(id, &a.op, e.to_string());
                }
            }
            match std::fs::rename(from, to) {
                Ok(_) => ok(id, &a.op, format!("moved to {to}")),
                Err(e) => err(id, &a.op, e.to_string()),
            }
        }

        "registry-remove-value" => {
            let (Some(hive), Some(name)) = (a.hive.as_deref(), a.value_name.as_deref()) else {
                return err(id, &a.op, "missing hive or value name");
            };
            match powershell(&format!(
                "Remove-ItemProperty -Path '{hive}' -Name '{name}' -Force -ErrorAction Stop; 'ok'"
            )) {
                Ok(_) => ok(id, &a.op, "value removed (recorded in manifest)"),
                Err(e) => err(id, &a.op, e),
            }
        }

        "registry-restore-value" => {
            let (Some(hive), Some(name), Some(val)) =
                (a.hive.as_deref(), a.value_name.as_deref(), a.recorded_value.as_deref())
            else {
                return err(id, &a.op, "missing hive, value name, or recorded value");
            };
            let escaped = val.replace('\'', "''");
            match powershell(&format!(
                "New-ItemProperty -Path '{hive}' -Name '{name}' -Value '{escaped}' \
                 -PropertyType String -Force -ErrorAction Stop | Out-Null; 'ok'"
            )) {
                Ok(_) => ok(id, &a.op, "value recreated"),
                Err(e) => err(id, &a.op, e),
            }
        }

        "task-disable" | "task-enable" => match a.command.as_deref() {
            Some(cmd) => match powershell(&format!("{cmd} -ErrorAction Stop | Out-Null; 'ok'")) {
                Ok(_) => ok(id, &a.op, "task definition kept"),
                Err(e) => err(id, &a.op, e),
            },
            None => err(id, &a.op, "no command recorded"),
        },

        "service-startuptype" => {
            let (Some(svc), Some(target)) = (a.service_name.as_deref(), a.target.as_deref()) else {
                return err(id, &a.op, "missing service name or target");
            };
            match powershell(&format!(
                "Set-Service -Name '{svc}' -StartupType {target} -ErrorAction Stop; 'ok'"
            )) {
                Ok(_) => ok(id, &a.op, format!("StartupType -> {target}")),
                Err(e) => err(id, &a.op, e),
            }
        }

        other => err(id, other, format!("unsupported op: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_admin_action_without_elevation_is_reported_as_skipped_not_attempted() {
        let a = Action {
            op: "service-startuptype".into(),
            service_name: Some("Nonexistent".into()),
            target: Some("Disabled".into()),
            needs_admin: true,
            ..Default::default()
        };
        let r = apply_action("svc::x", &a, false);
        assert!(!r.ok);
        assert!(r.error.unwrap().contains("elevated"), "must name elevation as the cause");
    }

    #[test]
    fn move_file_refuses_a_missing_source_rather_than_creating_one() {
        let a = Action {
            op: "move-file".into(),
            from: Some(r"C:\definitely\not\here\nope.lnk".into()),
            to: Some(std::env::temp_dir().join("hangar-nope.lnk").to_string_lossy().to_string()),
            ..Default::default()
        };
        let r = apply_action("x", &a, true);
        assert!(!r.ok);
        assert!(r.error.unwrap().contains("source not found"));
    }

    #[test]
    fn move_file_refuses_to_overwrite_an_occupied_destination() {
        let dir = std::env::temp_dir();
        let from = dir.join("hangar-mv-src.txt");
        let to = dir.join("hangar-mv-dst.txt");
        std::fs::write(&from, b"a").unwrap();
        std::fs::write(&to, b"b").unwrap();
        let a = Action {
            op: "move-file".into(),
            from: Some(from.to_string_lossy().to_string()),
            to: Some(to.to_string_lossy().to_string()),
            ..Default::default()
        };
        let r = apply_action("x", &a, true);
        assert!(!r.ok, "must not clobber an existing file");
        assert!(r.error.unwrap().contains("occupied"));
        // The source survives a refused move — nothing is lost.
        assert!(from.exists());
        let _ = std::fs::remove_file(&from);
        let _ = std::fs::remove_file(&to);
    }

    #[test]
    fn move_file_round_trips_and_preserves_content() {
        let dir = std::env::temp_dir().join("hangar-exec-test");
        std::fs::create_dir_all(&dir).unwrap();
        let a_path = dir.join("thing.lnk");
        let b_path = dir.join("q").join("thing.lnk");
        std::fs::write(&a_path, b"payload").unwrap();

        let fwd = Action {
            op: "move-file".into(),
            from: Some(a_path.to_string_lossy().to_string()),
            to: Some(b_path.to_string_lossy().to_string()),
            ..Default::default()
        };
        assert!(apply_action("x", &fwd, true).ok);
        assert!(!a_path.exists() && b_path.exists());

        let back = crate::persistence::invert_action(&fwd).unwrap();
        assert!(apply_action("x", &back, true).ok);
        assert!(a_path.exists(), "file returns to where it started");
        assert_eq!(std::fs::read(&a_path).unwrap(), b"payload", "content unchanged");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unsupported_op_fails_loudly_rather_than_silently_succeeding() {
        let r = apply_action("x", &Action::default(), true);
        assert!(!r.ok);
        assert!(r.error.unwrap().contains("unsupported"));
    }
}
