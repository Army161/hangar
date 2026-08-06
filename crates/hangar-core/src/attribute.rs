//! Attribution — Rust port of `lib/attribute.js`.
//!
//! Turns an anonymous process table into named owners. Two field-found bugs
//! are encoded as behaviour here and must not regress:
//!
//!   * **explorer rollup.** Fallback owners must NOT propagate to descendants.
//!     explorer launches half the desktop; inheriting its exe-name fallback
//!     made the dashboard report "explorer 14 GB / 91 procs" when explorer
//!     itself held 170 MB.
//!   * **phantom roots.** A root is a group member whose PARENT is outside the
//!     group — not merely a process that matched a signature directly. Sixteen
//!     sibling `claude.exe` renderers under one parent are ONE root. Getting
//!     this wrong produced the false "16 orphaned Claude instances" premise.

use crate::types::{Attributed, FanoutRow, OwnerGroup, Process};
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

pub mod kind {
    pub const MCP: &str = "mcp";
    pub const AGENT: &str = "agent";
    pub const RUNTIME: &str = "ai-runtime";
    pub const PROJECT: &str = "project";
    pub const DEVTOOL: &str = "devtool";
    pub const APP: &str = "app";
    pub const SYSTEM: &str = "system";
    pub const SHELL: &str = "shell";
}

/// How an extracted name is produced from a regex match.
enum Name {
    Fixed(&'static str),
    /// Capture group index.
    Group(usize),
    /// Last dot-segment of a capture group — turns
    /// `ant.dir.cursortouch.windows-mcp` into `windows-mcp`.
    LastDotSeg(usize),
}

struct Sig {
    re: &'static str,
    /// Optional exclusion. The JS used a negative lookahead, which the `regex`
    /// crate does not support; an explicit `not` is faster and clearer anyway.
    not: Option<&'static str>,
    kind: &'static str,
    name: Name,
    vendor: Option<Name>,
    reattach: bool,
}

macro_rules! sig {
    ($re:expr, $kind:expr, $name:expr) => {
        Sig { re: $re, not: None, kind: $kind, name: $name, vendor: None, reattach: false }
    };
    ($re:expr, $kind:expr, $name:expr, reattach) => {
        Sig { re: $re, not: None, kind: $kind, name: $name, vendor: None, reattach: true }
    };
    ($re:expr, $kind:expr, $name:expr, vendor $v:expr) => {
        Sig { re: $re, not: None, kind: $kind, name: $name, vendor: Some($v), reattach: false }
    };
    ($re:expr, not $n:expr, $kind:expr, $name:expr, reattach) => {
        Sig { re: $re, not: Some($n), kind: $kind, name: $name, vendor: None, reattach: true }
    };
}

fn signatures() -> &'static Vec<(Sig, Regex, Option<Regex>)> {
    static S: OnceLock<Vec<(Sig, Regex, Option<Regex>)>> = OnceLock::new();
    S.get_or_init(|| {
        let raw: Vec<Sig> = vec![
            // --- agent runtimes ---
            sig!(r"(?i)[\\/]\.openclaw[\\/]|node_modules[\\/]openclaw[\\/]", kind::AGENT, Name::Fixed("OpenClaw Gateway"), reattach),
            sig!(r"(?i)AppData[\\/]Local[\\/]hermes[\\/]|hermes_cli", not r"(?i)AppData[\\/]Local[\\/]hermes[\\/]bin[\\/]", kind::AGENT, Name::Fixed("Hermes Agent"), reattach),
            sig!(r#"(?i)ollama[\\/]ollama[\s"]|ollama\.exe|ollama app\.exe"#, kind::RUNTIME, Name::Fixed("Ollama"), reattach),
            sig!(r"(?i)\bclaude\.exe\b", kind::AGENT, Name::Fixed("Claude"), reattach),
            sig!(r"(?i)cursor\.exe", kind::AGENT, Name::Fixed("Cursor")),
            sig!(r"(?i)OpenClaw\.Tray", kind::AGENT, Name::Fixed("OpenClaw Tray"), reattach),
            sig!(r"(?i)kortix|suna[\\/]", kind::AGENT, Name::Fixed("Kortix"), reattach),
            sig!(r"(?i)[\\/]odysseus[\\/]|odysseus-odysseus", kind::PROJECT, Name::Fixed("Odysseus"), reattach),
            sig!(r"(?i)\bdyad\b", kind::APP, Name::Fixed("dyad")),
            // --- Claude extensions: vendor + package from the folder id ---
            Sig { re: r"(?i)Claude Extensions[\\/]([\w.\-]+)", not: None, kind: kind::MCP,
                  name: Name::LastDotSeg(1), vendor: None, reattach: false },
            // --- MCP servers by package shape ---
            sig!(r"(?i)mcp-server-([\w\-]+)", kind::MCP, Name::Group(0)),
            sig!(r"(?i)mcp-proxy-for-aws", kind::MCP, Name::Fixed("mcp-proxy-for-aws"), vendor Name::Fixed("awslabs")),
            Sig { re: r"(?i)@([\w\-]+)[\\/]([\w\-]*mcp[\w\-]*)", not: None, kind: kind::MCP,
                  name: Name::Group(2), vendor: Some(Name::Group(1)), reattach: false },
            Sig { re: r"(?i)node_modules[\\/]@([\w\-]+)[\\/]([\w\-]+)", not: None, kind: kind::MCP,
                  name: Name::Group(2), vendor: Some(Name::Group(1)), reattach: false },
            sig!(r"(?i)\b([\w\-]+-mcp(?:-server)?)\b", kind::MCP, Name::Group(1)),
            sig!(r"(?i)\bserena\b", kind::MCP, Name::Fixed("serena")),
            sig!(r"(?i)\bdesktop-?commander\b", kind::MCP, Name::Fixed("desktop-commander")),
            // --- dev tooling ---
            sig!(r"(?i)\b(vite|webpack|nodemon|ts-node|esbuild|turbopack)\b", kind::DEVTOOL, Name::Group(1)),
            sig!(r"(?i)\b(uvicorn|gunicorn|flask|django)\b", kind::DEVTOOL, Name::Group(1)),
            sig!(r"(?i)wslrelay\.exe|wslservice\.exe|wslhost\.exe|vmmemWSL|\bvmmem\b", kind::SYSTEM, Name::Fixed("WSL 2")),
            sig!(r"(?i)Docker Desktop|com\.docker", kind::APP, Name::Fixed("Docker Desktop")),
            // --- named desktop apps ---
            sig!(r"(?i)SignalRgb", kind::APP, Name::Fixed("SignalRGB")),
            sig!(r"(?i)terminal64\.exe|MetaTrader", kind::APP, Name::Fixed("MetaTrader 5"), reattach),
            sig!(r"(?i)Wondershare|Filmora|WsToastNotification", kind::APP, Name::Fixed("Wondershare Filmora")),
            sig!(r"(?i)OneDrive", kind::APP, Name::Fixed("OneDrive")),
            sig!(r"(?i)TradingView", kind::APP, Name::Fixed("TradingView")),
            sig!(r"(?i)msedgewebview2", kind::SYSTEM, Name::Fixed("Edge WebView2")),
            sig!(r"(?i)MsMpEng|MpDefenderCoreService|SecurityHealth", kind::SYSTEM, Name::Fixed("Microsoft Defender")),
            sig!(r"(?i)MSPCManager", kind::APP, Name::Fixed("Microsoft PC Manager")),
            sig!(r"(?i)nvcontainer|NVDisplay|NVIDIA", kind::SYSTEM, Name::Fixed("NVIDIA")),
        ];
        raw.into_iter()
            .map(|s| {
                let re = Regex::new(s.re).expect("static signature");
                let not = s.not.map(|n| Regex::new(n).expect("static exclusion"));
                (s, re, not)
            })
            .collect()
    })
}

/// Extractions that technically matched but carry no information.
fn bad_names() -> &'static HashSet<&'static str> {
    static S: OnceLock<HashSet<&'static str>> = OnceLock::new();
    S.get_or_init(|| {
        [
            "mcp", "mcp-server", "server", "index", "main", "dist", "build", "bin", ".bin",
            "npm", "npx", "node", "run", "start", "cli", "lib", "src", "app", ".", "..",
            "start-mcp-server", "run-mcp-server", "serve", "stdio", "notebook-tools",
        ]
        .into_iter()
        .collect()
    })
}

fn not_a_project() -> &'static HashSet<&'static str> {
    static S: OnceLock<HashSet<&'static str>> = OnceLock::new();
    S.get_or_init(|| {
        [
            "appdata", "scoop", "onedrive", "documents", "downloads", "desktop", "pictures",
            "videos", "music", "node_modules", ".cache", ".claude", ".cursor", ".vscode",
            ".git", ".npm", ".nuget", ".dotnet", ".gradle", ".docker", ".ssh", "nvm4w",
            "contacts", "favorites", "links", "searches", "saved games", "3d objects",
        ]
        .into_iter()
        .collect()
    })
}

fn shells() -> &'static HashSet<&'static str> {
    static S: OnceLock<HashSet<&'static str>> = OnceLock::new();
    S.get_or_init(|| {
        ["cmd.exe", "conhost.exe", "powershell.exe", "pwsh.exe", "wscript.exe", "cscript.exe"]
            .into_iter().collect()
    })
}

fn system_procs() -> &'static HashSet<&'static str> {
    static S: OnceLock<HashSet<&'static str>> = OnceLock::new();
    S.get_or_init(|| {
        [
            "svchost.exe", "System", "Registry", "smss.exe", "csrss.exe", "wininit.exe",
            "services.exe", "lsass.exe", "winlogon.exe", "fontdrvhost.exe", "dwm.exe",
            "RuntimeBroker.exe", "Memory Compression", "System Idle Process", "dllhost.exe",
            "sihost.exe", "taskhostw.exe", "ctfmon.exe", "spoolsv.exe", "audiodg.exe",
        ]
        .into_iter().collect()
    })
}

#[derive(Clone, Debug)]
struct Resolved {
    owner: String,
    kind: &'static str,
    vendor: Option<String>,
    owner_pid: u32,
    inherited: bool,
    confidence: &'static str,
    reattach: bool,
    project_path: Option<String>,
    /// `Always` propagates to every descendant; `SameExe` only to children
    /// running the same executable (an app's own renderers); `Never` stops.
    prop: Prop,
    src_name: String,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Prop {
    Always,
    SameExe,
    Never,
}

fn extract(name: &Name, caps: &regex::Captures) -> Option<String> {
    match name {
        Name::Fixed(s) => Some((*s).to_string()),
        Name::Group(i) => caps.get(*i).map(|m| m.as_str().to_string()),
        Name::LastDotSeg(i) => caps.get(*i).map(|m| {
            let s = m.as_str();
            s.rsplit('.').next().unwrap_or(s).to_string()
        }),
    }
}

/// One pass over all signature patterns to find candidates, instead of running
/// ~30 separate regexes against every process. With 781 processes that is the
/// difference between ~23,000 regex executions and one set scan each.
fn signature_set() -> &'static regex::RegexSet {
    static S: OnceLock<regex::RegexSet> = OnceLock::new();
    S.get_or_init(|| {
        regex::RegexSet::new(signatures().iter().map(|(s, _, _)| s.re)).expect("static signature set")
    })
}

fn match_signature(p: &Process) -> Option<Resolved> {
    let hay = p.haystack();
    let sigs = signatures();
    // Candidate indices come back ascending, which preserves first-match-wins.
    for idx in signature_set().matches(&hay).into_iter() {
        let (sig, re, not) = &sigs[idx];
        if let Some(nre) = not {
            if nre.is_match(&hay) {
                continue;
            }
        }
        let Some(caps) = re.captures(&hay) else { continue };
        let Some(owner) = extract(&sig.name, &caps) else { continue };
        if owner.is_empty() || bad_names().contains(owner.to_lowercase().as_str()) {
            continue; // a meaningless label is worse than no rule at all
        }
        return Some(Resolved {
            owner,
            kind: sig.kind,
            vendor: sig.vendor.as_ref().and_then(|v| extract(v, &caps)),
            owner_pid: p.pid,
            inherited: false,
            confidence: "signature",
            reattach: sig.reattach,
            project_path: None,
            prop: Prop::Always,
            src_name: p.name.clone(),
        });
    }
    None
}

/// Project-path patterns depend on the home directory, so they cannot be
/// `static` — but they must still be compiled ONCE per run, not once per
/// process. Compiling inside the loop made attribution slower than the
/// syscall-bound collector it feeds.
struct ProjectMatcher {
    pats: Vec<Regex>,
}

impl ProjectMatcher {
    fn new(home: &str) -> Self {
        if home.is_empty() {
            return Self { pats: Vec::new() };
        }
        let user = home.rsplit(['\\', '/']).next().unwrap_or("");
        // Folder names routinely contain spaces ("fable 5 tasty trade options
        // 3"), so consume up to the next separator or quote, not the next space.
        let pats = [
            format!(r#"(?i){}[\\/]([^\\/"]+?)(?:[\\/"]|$)"#, regex::escape(home)),
            format!(r#"(?i)/mnt/[a-z]/users/{}/([^/"]+?)(?:[/"]|$)"#, regex::escape(user)),
        ];
        Self {
            pats: pats.iter().filter_map(|p| Regex::new(p).ok()).collect(),
        }
    }
}

fn not_a_project_ext() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)\.(exe|dll|txt|json|log|md)$").unwrap())
}

fn match_project(p: &Process, home: &str, pm: &ProjectMatcher) -> Option<Resolved> {
    let cmd = p.cmd.as_deref().or(p.path.as_deref())?;
    for re in &pm.pats {
        for caps in re.captures_iter(cmd) {
            let Some(folder) = caps.get(1).map(|m| m.as_str()) else { continue };
            if not_a_project().contains(folder.to_lowercase().as_str()) {
                continue;
            }
            if not_a_project_ext().is_match(folder) {
                continue;
            }
            return Some(Resolved {
                owner: folder.to_string(),
                kind: kind::PROJECT,
                vendor: None,
                owner_pid: p.pid,
                inherited: false,
                confidence: "project-path",
                reattach: true,
                project_path: Some(format!("{}\\{}", home, folder)),
                prop: Prop::Always,
                src_name: p.name.clone(),
            });
        }
    }
    None
}

pub struct Attribution {
    pub processes: Vec<Attributed>,
    pub owners: Vec<OwnerGroup>,
    pub fanout: Vec<FanoutRow>,
}

pub fn attribute(processes: &[Process], home: &str) -> Attribution {
    let by_pid: HashMap<u32, &Process> = processes.iter().map(|p| (p.pid, p)).collect();

    let pm = ProjectMatcher::new(home);
    let mut direct: HashMap<u32, Resolved> = HashMap::new();
    for p in processes {
        if let Some(r) = match_signature(p).or_else(|| match_project(p, home, &pm)) {
            direct.insert(p.pid, r);
        }
    }

    let mut resolved: HashMap<u32, Resolved> = HashMap::new();
    for p in processes {
        resolve(p.pid, &by_pid, &direct, &mut resolved, &mut HashSet::new());
    }

    let decorated: Vec<Attributed> = processes
        .iter()
        .map(|p| {
            let a = resolved.get(&p.pid);
            Attributed {
                proc: p.clone(),
                owner: a.map(|x| x.owner.clone()).unwrap_or_else(|| p.name.clone()),
                kind: a.map(|x| x.kind.to_string()).unwrap_or_else(|| kind::APP.into()),
                vendor: a.and_then(|x| x.vendor.clone()),
                owner_pid: a.map(|x| x.owner_pid).unwrap_or(p.pid),
                inherited: a.map(|x| x.inherited).unwrap_or(false),
                confidence: a.map(|x| x.confidence.to_string()).unwrap_or_else(|| "exe-name".into()),
                reattach: a.map(|x| x.reattach).unwrap_or(false),
                project_path: a.and_then(|x| x.project_path.clone()),
            }
        })
        .collect();

    // ---- roll up by owner ----
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, OwnerGroup> = HashMap::new();
    for d in &decorated {
        let key = format!("{}::{}", d.kind, d.owner);
        let g = groups.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            OwnerGroup {
                key: key.clone(),
                owner: d.owner.clone(),
                kind: d.kind.clone(),
                vendor: d.vendor.clone(),
                procs: 0,
                mem_mb: 0.0,
                cpu_sec: 0.0,
                pids: Vec::new(),
                root_pids: Vec::new(),
                reattach: d.reattach,
                project_path: d.project_path.clone(),
                oldest: d.proc.started.clone(),
            }
        });
        g.procs += 1;
        g.mem_mb += d.proc.mem_mb;
        g.cpu_sec += d.proc.cpu_sec;
        g.pids.push(d.proc.pid);
        if d.reattach {
            g.reattach = true;
        }
        if g.project_path.is_none() {
            g.project_path = d.project_path.clone();
        }
        if let Some(s) = &d.proc.started {
            if g.oldest.as_ref().map(|o| s < o).unwrap_or(true) {
                g.oldest = Some(s.clone());
            }
        }
    }

    // A root is a member whose PARENT is outside the group. Direct-match count
    // is the wrong definition — 16 sibling renderers are one tree.
    let mut owners: Vec<OwnerGroup> = order
        .into_iter()
        .map(|k| {
            let mut g = groups.remove(&k).unwrap();
            let members: HashSet<u32> = g.pids.iter().copied().collect();
            g.root_pids = g
                .pids
                .iter()
                .copied()
                .filter(|pid| match by_pid.get(pid) {
                    Some(p) => !members.contains(&p.ppid),
                    None => true,
                })
                .collect();
            g.mem_mb = (g.mem_mb * 10.0).round() / 10.0;
            g
        })
        .collect();
    owners.sort_by(|a, b| b.mem_mb.partial_cmp(&a.mem_mb).unwrap_or(std::cmp::Ordering::Equal));

    let mut fanout: Vec<FanoutRow> = owners
        .iter()
        .filter(|g| g.root_pids.len() > 1 && g.kind != kind::SYSTEM)
        .map(|g| {
            let copies = g.root_pids.len();
            FanoutRow {
                owner: g.owner.clone(),
                kind: g.kind.clone(),
                vendor: g.vendor.clone(),
                copies,
                procs: g.procs,
                mem_mb: g.mem_mb,
                reclaim_mb: ((g.mem_mb * (copies - 1) as f64 / copies as f64) * 10.0).round() / 10.0,
            }
        })
        .collect();
    fanout.sort_by(|a, b| b.reclaim_mb.partial_cmp(&a.reclaim_mb).unwrap_or(std::cmp::Ordering::Equal));

    Attribution { processes: decorated, owners, fanout }
}

fn resolve(
    pid: u32,
    by_pid: &HashMap<u32, &Process>,
    direct: &HashMap<u32, Resolved>,
    out: &mut HashMap<u32, Resolved>,
    seen: &mut HashSet<u32>,
) -> Option<Resolved> {
    if let Some(r) = out.get(&pid) {
        return Some(r.clone());
    }
    if !seen.insert(pid) {
        return None; // cycle guard
    }
    let proc = by_pid.get(&pid)?;

    let r = if let Some(own) = direct.get(&pid) {
        own.clone()
    } else {
        let from_parent = by_pid
            .get(&proc.ppid)
            .and_then(|_| resolve(proc.ppid, by_pid, direct, out, seen));

        // Inheritance rules — this is the explorer-rollup fix.
        let can_inherit = from_parent.as_ref().is_some_and(|fp| match fp.prop {
            Prop::Always => true,
            Prop::SameExe => fp.src_name == proc.name,
            Prop::Never => false,
        });

        if can_inherit {
            let fp = from_parent.unwrap();
            Resolved { inherited: true, confidence: "inherited", ..fp }
        } else if system_procs().contains(proc.name.as_str()) {
            Resolved {
                owner: "Windows".into(), kind: kind::SYSTEM, vendor: None, owner_pid: pid,
                inherited: false, confidence: "system", reattach: false, project_path: None,
                prop: Prop::Never, src_name: proc.name.clone(),
            }
        } else if shells().contains(proc.name.as_str()) {
            Resolved {
                owner: "Loose shell".into(), kind: kind::SHELL, vendor: None, owner_pid: pid,
                inherited: false, confidence: "shell", reattach: false, project_path: None,
                prop: Prop::Never, src_name: proc.name.clone(),
            }
        } else {
            Resolved {
                owner: proc.name.trim_end_matches(".exe").trim_end_matches(".EXE").to_string(),
                kind: kind::APP, vendor: None, owner_pid: pid, inherited: false,
                confidence: "exe-name", reattach: false, project_path: None,
                prop: Prop::SameExe, src_name: proc.name.clone(),
            }
        }
    };
    out.insert(pid, r.clone());
    Some(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = r"C:\Users\Armyg";

    fn p(pid: u32, ppid: u32, name: &str, mem: f64, cmd: &str) -> Process {
        Process { pid, ppid, name: name.into(), mem_mb: mem, cmd: Some(cmd.into()), ..Default::default() }
    }

    #[test]
    fn unmatched_apps_launched_from_explorer_do_not_inherit_explorer() {
        let procs = vec![
            p(100, 1, "explorer.exe", 170.0, "explorer"),
            p(200, 100, "dyad2.exe", 900.0, r#""C:\Programs\d2\dyad2.exe""#),
            p(201, 200, "dyad2.exe", 220.0, "dyad2 renderer"),
        ];
        let a = attribute(&procs, HOME);
        let explorer = a.owners.iter().find(|o| o.owner == "explorer").unwrap();
        let d = a.owners.iter().find(|o| o.owner == "dyad2").unwrap();
        assert_eq!(d.procs, 2, "renderer inherits from its own exe, not explorer");
        assert!(explorer.mem_mb < 200.0, "explorer holds only its own memory: {}", explorer.mem_mb);
    }

    #[test]
    fn signature_matches_still_inherit_through_shells() {
        let procs = vec![
            p(300, 1, "claude.exe", 800.0, "claude main"),
            p(301, 300, "cmd.exe", 8.0, "cmd /c npx something"),
            p(302, 301, "node.exe", 90.0, "node some-generic-thing.js"),
        ];
        let a = attribute(&procs, HOME);
        let c = a.owners.iter().find(|o| o.owner == "Claude").unwrap();
        assert_eq!(c.procs, 3);
    }

    #[test]
    fn sixteen_sibling_renderers_are_one_root_not_sixteen() {
        let mut procs = vec![p(400, 1, "claude.exe", 800.0, "claude main")];
        for i in 1..=15 {
            procs.push(p(400 + i, 400, "claude.exe", 120.0, "claude renderer"));
        }
        let a = attribute(&procs, HOME);
        let c = a.owners.iter().find(|o| o.owner == "Claude").unwrap();
        assert_eq!(c.procs, 16);
        assert_eq!(c.root_pids.len(), 1, "one tree = one root, got {:?}", c.root_pids);
        assert_eq!(c.root_pids, vec![400]);
        assert!(!a.fanout.iter().any(|f| f.owner == "Claude"), "one tree is not a duplicate");
    }

    #[test]
    fn two_independent_trees_of_the_same_owner_are_two_roots() {
        let procs = vec![
            p(500, 1, "node.exe", 100.0, "npx mongodb-mcp-server"),
            p(501, 500, "node.exe", 80.0, "node mongodb-mcp-server/dist/index.js"),
            p(600, 2, "node.exe", 95.0, "npx mongodb-mcp-server"),
        ];
        let a = attribute(&procs, HOME);
        let m = a.owners.iter().find(|o| o.owner == "mongodb-mcp-server").unwrap();
        assert_eq!(m.root_pids.len(), 2, "two independent launches = two roots");
        let f = a.fanout.iter().find(|f| f.owner == "mongodb-mcp-server").unwrap();
        assert_eq!(f.copies, 2);
    }

    #[test]
    fn project_folders_with_spaces_survive() {
        let procs = vec![p(700, 1, "cmd.exe", 8.0,
            r#""C:\Users\Armyg\fable 5 tasty trade options 3\run_scan.bat""#)];
        let a = attribute(&procs, HOME);
        assert!(a.owners.iter().any(|o| o.owner == "fable 5 tasty trade options 3"),
                "got {:?}", a.owners.iter().map(|o| &o.owner).collect::<Vec<_>>());
    }

    #[test]
    fn wsl_infrastructure_is_wsl_but_a_wsl_launched_script_is_the_project() {
        let procs = vec![
            p(800, 1, "wslrelay.exe", 5.0, "--mode 2 --vm-id x"),
            p(801, 1, "wsl.exe", 4.0,
              "wsl.exe -d Ubuntu -- bash -c 'python /mnt/c/users/Armyg/TAO_WALLET/tao_alerts.py'"),
        ];
        let a = attribute(&procs, HOME);
        assert!(a.owners.iter().any(|o| o.owner == "WSL 2"));
        assert!(a.owners.iter().any(|o| o.owner == "TAO_WALLET"),
                "a wsl-launched script belongs to its project, got {:?}",
                a.owners.iter().map(|o| &o.owner).collect::<Vec<_>>());
    }

    #[test]
    fn meaningless_extractions_fall_through_to_the_next_rule() {
        // "start-mcp-server" is a CLI verb, not a package name.
        let procs = vec![p(900, 1, "python.exe", 100.0, r"...\serena.exe start-mcp-server")];
        let a = attribute(&procs, HOME);
        assert_eq!(a.owners[0].owner, "serena");
    }
}
