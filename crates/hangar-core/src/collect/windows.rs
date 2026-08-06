//! Windows listening-port collector.
//!
//! Shells out to `netstat -ano` rather than binding `GetExtendedTcpTable`
//! directly. That is a deliberate M2 trade: it is a few milliseconds slower
//! but adds no unsafe blocks and no extra dependency, and the port list is
//! small. If profiling ever shows it matters, the Win32 call is a contained
//! swap behind this same function signature.

use crate::types::PortRow;
use std::process::Command;

pub fn listening_ports() -> Vec<PortRow> {
    let Ok(out) = Command::new("netstat").args(["-ano", "-p", "TCP"]).output() else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut rows = Vec::new();

    for line in text.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        // Proto  Local            Foreign          State       PID
        if f.len() < 5 || !f[0].eq_ignore_ascii_case("TCP") || f[3] != "LISTENING" {
            continue;
        }
        let local = f[1];
        // IPv6 arrives as [::]:7420, IPv4 as 0.0.0.0:7420 — split on the last colon.
        let Some(idx) = local.rfind(':') else { continue };
        let (addr, port_s) = local.split_at(idx);
        let Ok(port) = port_s[1..].parse::<u16>() else { continue };
        let Ok(pid) = f[4].parse::<u32>() else { continue };
        rows.push(PortRow {
            port,
            addr: addr.trim_matches(['[', ']']).to_string(),
            pid,
        });
    }

    rows.sort_by_key(|r| (r.port, r.pid));
    rows.dedup_by_key(|r| r.port);
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listening_ports_are_readable_and_plausible() {
        let ports = listening_ports();
        // A Windows box always has something listening (RPC on 135, SMB, etc).
        assert!(!ports.is_empty(), "expected at least one listening port");
        for p in &ports {
            assert!(p.port > 0);
            assert!(p.pid > 0 || p.port == 0, "a listening port has an owning pid");
        }
        // Ports are deduplicated by port number.
        let mut seen = std::collections::HashSet::new();
        for p in &ports {
            assert!(seen.insert(p.port), "port {} appeared twice", p.port);
        }
    }
}
