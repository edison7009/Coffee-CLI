//! Where the in-app self-update downloads the installer from.
//!
//! Sources, in order of preference:
//!   1. CNB mirror      — cnb.cool/echobird/coffee-cli-releases
//!   2. GitCode mirror  — gitcode.com/edison7009/coffee-cli-releases
//!   3. The website     — coffeecli.com/download/<os> (proxies GitHub)
//! The mirrors are filled by .github/workflows/mirror-release.yml and each
//! carries a manifest.json: { version, files: { <name>: { size, sha256 } } }.
//!
//! The target version is the newest one any source reports (the website's
//! version.json counts too), so a lagging or dead mirror can neither hide a
//! release nor serve an old installer: a mirror is only used when its
//! manifest has exactly the target version. Candidates race for a moment
//! (`probe`); the fastest one is downloaded and checked against the
//! manifest's size and SHA-256, and a failed check moves on to the next.
//!
//! The planning half is pure (and unit-tested); network I/O is `ureq`,
//! blocking, run by the caller on a spawn_blocking thread.

use std::collections::HashMap;
use std::io::Read;
use std::time::{Duration, Instant};

pub const OFFICIAL_VERSION_URL: &str = "https://coffeecli.com/version.json";

pub struct Mirror {
    pub id: &'static str,
    pub manifest_url: &'static str,
    file_url: fn(&str) -> String,
}

fn cnb_file(name: &str) -> String {
    format!("https://cnb.cool/echobird/coffee-cli-releases/-/git/raw/main/{}", encode(name))
}
fn gitcode_file(name: &str) -> String {
    format!(
        "https://api.gitcode.com/api/v5/repos/edison7009/coffee-cli-releases/raw/{}?ref=main",
        encode(name)
    )
}

pub const MIRRORS: &[Mirror] = &[
    Mirror {
        id: "cnb",
        manifest_url: "https://cnb.cool/echobird/coffee-cli-releases/-/git/raw/main/manifest.json",
        file_url: cnb_file,
    },
    Mirror {
        id: "gitcode",
        manifest_url: "https://api.gitcode.com/api/v5/repos/edison7009/coffee-cli-releases/raw/manifest.json?ref=main",
        file_url: gitcode_file,
    },
];

/// Percent-encode a release asset name for a URL path segment.
fn encode(name: &str) -> String {
    name.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct FileEntry {
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub files: HashMap<String, FileEntry>,
}

/// One place the installer can come from.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub id: &'static str,
    pub url: String,
    /// Expected size and digest; None when the source has no manifest entry.
    pub expect: Option<FileEntry>,
    /// The website answers with whatever GitHub's latest release is; its
    /// installer is only checked against `expect` when its X-Coffee-Version
    /// header matches this version.
    pub check_header_version: Option<String>,
}

fn parse_semver(v: &str) -> Option<(u64, u64, u64)> {
    let mut it = v.trim().trim_start_matches('v').split('.');
    let a = it.next()?.parse().ok()?;
    let b = it.next()?.parse().ok()?;
    let c = it.next()?.parse().ok()?;
    if it.next().is_some() {
        return None;
    }
    Some((a, b, c))
}

/// Does this release asset name belong to the running platform?
/// `os` is "windows" | "macos" | "linux"; `arch` is std::env::consts::ARCH.
pub fn asset_for_platform(os: &str, arch: &str, name: &str) -> bool {
    match os {
        "windows" => name.ends_with("Windows_x64-setup.exe"),
        "macos" if arch == "aarch64" => name.ends_with("macOS_arm64.dmg"),
        "macos" => name.ends_with("macOS_x64.dmg"),
        _ => false,
    }
}

/// Decide the target version and the ordered candidate list.
/// `mirrors[i]` is the manifest fetched from `MIRRORS[i]` (None = unreachable).
pub fn plan(
    os: &str,
    arch: &str,
    mirrors: &[Option<Manifest>],
    official_version: Option<&str>,
    official_url: &str,
) -> (Option<String>, Vec<Candidate>) {
    let mut target: Option<(u64, u64, u64)> = official_version.and_then(parse_semver);
    for m in mirrors.iter().flatten() {
        if let Some(v) = parse_semver(&m.version) {
            if target.map_or(true, |t| v > t) {
                target = Some(v);
            }
        }
    }
    let Some(target) = target else {
        // Nothing reachable told us a version: the website is all we have.
        return (None, vec![Candidate { id: "website", url: official_url.into(), expect: None, check_header_version: None }]);
    };
    let target_str = format!("{}.{}.{}", target.0, target.1, target.2);

    let mut out = Vec::new();
    let mut known: Option<FileEntry> = None;
    for (mirror, manifest) in MIRRORS.iter().zip(mirrors.iter()) {
        let Some(m) = manifest else { continue };
        if parse_semver(&m.version) != Some(target) {
            continue;
        }
        let mut names: Vec<&String> = m.files.keys().filter(|n| asset_for_platform(os, arch, n)).collect();
        names.sort();
        if let Some(name) = names.first() {
            let entry = m.files[*name].clone();
            known.get_or_insert_with(|| entry.clone());
            out.push(Candidate {
                id: mirror.id,
                url: (mirror.file_url)(name),
                expect: Some(entry),
                check_header_version: None,
            });
        }
    }
    out.push(Candidate {
        id: "website",
        url: official_url.into(),
        expect: known,
        check_header_version: Some(target_str.clone()),
    });
    (Some(target_str), out)
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(8))
        .timeout_read(Duration::from_secs(30))
        .redirects(5)
        .user_agent(concat!("CoffeeCLI/", env!("CARGO_PKG_VERSION")))
        .build()
}

pub fn fetch_manifest(url: &str) -> Option<Manifest> {
    let resp = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(8))
        .redirects(5)
        .build()
        .get(url)
        .call()
        .ok()?;
    let m: Manifest = serde_json::from_reader(resp.into_reader().take(1 << 20)).ok()?;
    parse_semver(&m.version).map(|_| m)
}

/// Fetch every source's manifest in parallel and plan the download.
pub fn resolve(os: &str, official_url: &str) -> (Option<String>, Vec<Candidate>) {
    let mut handles: Vec<_> = MIRRORS
        .iter()
        .map(|m| {
            let url = m.manifest_url;
            std::thread::spawn(move || fetch_manifest(url))
        })
        .collect();
    let official = std::thread::spawn(|| fetch_manifest(OFFICIAL_VERSION_URL));
    let mirrors: Vec<Option<Manifest>> = handles.drain(..).map(|h| h.join().ok().flatten()).collect();
    let official_version = official.join().ok().flatten().map(|m| m.version);
    plan(os, std::env::consts::ARCH, &mirrors, official_version.as_deref(), official_url)
}

/// An opened download: what the probe already read, plus the live stream.
pub struct Opened {
    pub candidate: Candidate,
    pub head: Vec<u8>,
    pub reader: Box<dyn Read + Send + Sync>,
    pub total: Option<u64>,
    pub header_version: Option<String>,
    pub eof: bool,
    /// Bytes per second during the probe (0 when not raced).
    pub rate: f64,
}

/// How much each racing source may read before it is judged: enough to
/// measure, small enough that losers waste little bandwidth.
const PROBE_CAP: usize = 512 * 1024;

/// Open every candidate at once, read each for up to `window` (or
/// PROBE_CAP bytes), and return the ones that answered, fastest first.
/// With a single candidate there is nothing to race: it is opened directly.
pub fn probe(candidates: &[Candidate], window: Duration) -> Vec<Opened> {
    let (tx, rx) = std::sync::mpsc::channel();
    for (i, c) in candidates.iter().cloned().enumerate() {
        let tx = tx.clone();
        let race = candidates.len() > 1;
        std::thread::spawn(move || {
            let Ok(resp) = agent().get(&c.url).call() else { return };
            let total = resp.header("Content-Length").and_then(|s| s.parse().ok());
            let header_version = resp.header("X-Coffee-Version").map(str::to_string);
            let mut reader = resp.into_reader();
            let mut head = Vec::new();
            let mut eof = false;
            let mut rate = 0.0;
            if race {
                let start = Instant::now();
                let mut buf = [0u8; 65536];
                while start.elapsed() < window && head.len() < PROBE_CAP {
                    match reader.read(&mut buf) {
                        Ok(0) => { eof = true; break; }
                        Ok(n) => head.extend_from_slice(&buf[..n]),
                        Err(_) => return,
                    }
                }
                rate = head.len() as f64 / start.elapsed().as_secs_f64().max(0.001);
            }
            let _ = tx.send((i, Opened { candidate: c, head, reader, total, header_version, eof, rate }));
        });
    }
    drop(tx);
    // Connects are bounded by the agent's timeout; wait a little past it.
    let deadline = Instant::now() + window + Duration::from_secs(10);
    let mut opened: Vec<(usize, Opened)> = Vec::new();
    while opened.len() < candidates.len() {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(o) => opened.push(o),
            Err(_) => break,
        }
    }
    // Fastest first. Rates within 20% of each other count as a tie, which
    // keeps the preference order (mirrors before the website).
    opened.sort_by(|(ia, a), (ib, b)| {
        let (ra, rb) = (a.rate, b.rate);
        if (ra - rb).abs() <= 0.2 * ra.max(rb) { ia.cmp(ib) } else { rb.total_cmp(&ra) }
    });
    opened.into_iter().map(|(_, o)| o).collect()
}

/// After the download: does the file match what the source promised?
pub fn verify(c: &Candidate, header_version: Option<&str>, size: u64, sha256_hex: &str) -> Result<(), String> {
    let Some(expect) = &c.expect else { return Ok(()) };
    if let Some(v) = &c.check_header_version {
        // Website: only comparable when it served the same version.
        if header_version.map(|h| h.trim_start_matches('v')) != Some(v.as_str()) {
            return Ok(());
        }
    }
    if size != expect.size {
        return Err(format!("{}: size {} != {}", c.id, size, expect.size));
    }
    if !sha256_hex.eq_ignore_ascii_case(&expect.sha256) {
        return Err(format!("{}: sha256 mismatch", c.id));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(version: &str, names: &[&str]) -> Manifest {
        Manifest {
            version: version.into(),
            files: names
                .iter()
                .map(|n| (n.to_string(), FileEntry { size: 10, sha256: format!("sha-{n}") }))
                .collect(),
        }
    }
    const WIN: &str = "Coffee.CLI_3.9.2_Windows_x64-setup.exe";
    const ALL: &[&str] = &[
        "Coffee.CLI_3.9.2_Windows_x64-setup.exe", "Coffee.CLI_3.9.2_Windows_x64.msi",
        "Coffee.CLI_3.9.2_macOS_arm64.dmg", "Coffee.CLI_3.9.2_macOS_x64.dmg",
        "Coffee.CLI_3.9.2_Linux_x64.deb",
    ];
    const SITE: &str = "https://coffeecli.com/download/windows";

    #[test]
    fn platform_assets() {
        assert!(asset_for_platform("windows", "x86_64", WIN));
        assert!(!asset_for_platform("windows", "x86_64", "Coffee.CLI_3.9.2_Windows_x64.msi"));
        assert!(asset_for_platform("macos", "aarch64", "Coffee.CLI_3.9.2_macOS_arm64.dmg"));
        assert!(!asset_for_platform("macos", "aarch64", "Coffee.CLI_3.9.2_macOS_x64.dmg"));
        assert!(asset_for_platform("macos", "x86_64", "Coffee.CLI_3.9.2_macOS_x64.dmg"));
        assert!(!asset_for_platform("linux", "x86_64", "Coffee.CLI_3.9.2_Linux_x64.deb"));
    }

    #[test]
    fn both_mirrors_current() {
        let (v, c) = plan("windows", "x86_64", &[Some(manifest("3.9.2", ALL)), Some(manifest("3.9.2", ALL))], Some("3.9.2"), SITE);
        assert_eq!(v.as_deref(), Some("3.9.2"));
        assert_eq!(c.iter().map(|c| c.id).collect::<Vec<_>>(), ["cnb", "gitcode", "website"]);
        assert!(c[0].url.ends_with("/raw/main/Coffee.CLI_3.9.2_Windows_x64-setup.exe"));
        assert!(c[1].url.contains("/raw/Coffee.CLI_3.9.2_Windows_x64-setup.exe?ref=main"));
        assert_eq!(c[0].expect.as_ref().unwrap().sha256, format!("sha-{WIN}"));
        // The website is checked with the mirrors' digest, if it serves 3.9.2.
        assert_eq!(c[2].expect, c[0].expect);
        assert_eq!(c[2].check_header_version.as_deref(), Some("3.9.2"));
    }

    #[test]
    fn lagging_mirror_is_skipped_not_followed() {
        // The website already has 3.9.2; CNB still has 3.9.1: CNB must not serve the old installer.
        let (v, c) = plan("windows", "x86_64", &[Some(manifest("3.9.1", ALL)), Some(manifest("3.9.2", ALL))], Some("3.9.2"), SITE);
        assert_eq!(v.as_deref(), Some("3.9.2"));
        assert_eq!(c.iter().map(|c| c.id).collect::<Vec<_>>(), ["gitcode", "website"]);
    }

    #[test]
    fn mirror_ahead_of_website() {
        // Website version.json not bumped yet: the mirrors' newer version wins.
        let (v, c) = plan("windows", "x86_64", &[Some(manifest("3.9.2", ALL)), None], Some("3.9.1"), SITE);
        assert_eq!(v.as_deref(), Some("3.9.2"));
        assert_eq!(c.iter().map(|c| c.id).collect::<Vec<_>>(), ["cnb", "website"]);
    }

    #[test]
    fn mirrors_down_or_missing_file() {
        let (v, c) = plan("windows", "x86_64", &[None, Some(manifest("3.9.2", &["Coffee.CLI_3.9.2_Linux_x64.deb"]))], Some("3.9.2"), SITE);
        assert_eq!(v.as_deref(), Some("3.9.2"));
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].id, "website");
        assert_eq!(c[0].expect, None);
    }

    #[test]
    fn nothing_reachable() {
        let (v, c) = plan("windows", "x86_64", &[None, None], None, SITE);
        assert_eq!(v, None);
        assert_eq!(c, vec![Candidate { id: "website", url: SITE.into(), expect: None, check_header_version: None }]);
    }

    #[test]
    fn bad_versions_ignored() {
        let (v, _) = plan("windows", "x86_64", &[Some(manifest("latest", ALL)), Some(manifest("3.10.0.1", ALL))], Some("3.9.2"), SITE);
        assert_eq!(v.as_deref(), Some("3.9.2"));
        // 3.10.0 > 3.9.9 numerically, not lexically.
        let (v, c) = plan("windows", "x86_64", &[Some(manifest("3.10.0", ALL)), None], Some("3.9.9"), SITE);
        assert_eq!(v.as_deref(), Some("3.10.0"));
        assert_eq!(c[0].id, "cnb");
    }

    #[test]
    fn verification() {
        let c = Candidate { id: "cnb", url: String::new(), expect: Some(FileEntry { size: 3, sha256: "ABC".into() }), check_header_version: None };
        assert!(verify(&c, None, 3, "abc").is_ok());
        assert!(verify(&c, None, 4, "abc").is_err());
        assert!(verify(&c, None, 3, "abd").is_err());
        let site = Candidate { check_header_version: Some("3.9.2".into()), id: "website", ..c.clone() };
        assert!(verify(&site, Some("3.9.2"), 4, "zzz").is_err(), "same version must match the digest");
        assert!(verify(&site, Some("3.9.3"), 4, "zzz").is_ok(), "website moved on: nothing to compare against");
        assert!(verify(&site, None, 4, "zzz").is_ok());
        let none = Candidate { expect: None, ..c };
        assert!(verify(&none, None, 99, "x").is_ok());
    }

    /// Live network check (run by hand: `cargo test live_probe -- --ignored`):
    /// races the real CNB mirror against the website for the v3.9.1 macOS ARM
    /// installer and verifies the winner byte-for-byte.
    #[test]
    #[ignore]
    fn live_probe() {
        use sha2::{Digest, Sha256};
        let name = "Coffee.CLI_3.9.1_macOS_arm64.dmg";
        let expect = FileEntry { size: 20568407, sha256: "e8b7f03ea0369e1e853cee519b8a38f6ac094923c3e2f94e5e3f60085e937c44".into() };
        let cands = vec![
            Candidate { id: "cnb", url: cnb_file(name), expect: Some(expect.clone()), check_header_version: None },
            Candidate { id: "website", url: "https://coffeecli.com/download/macos-arm".into(), expect: Some(expect), check_header_version: Some("3.9.1".into()) },
        ];
        let opened = probe(&cands, Duration::from_millis(1500));
        assert!(!opened.is_empty());
        for o in &opened { eprintln!("probe {}: {} bytes, {:.0} KB/s", o.candidate.id, o.head.len(), o.rate / 1024.0); }
        let mut o = opened.into_iter().next().unwrap();
        let mut h = Sha256::new();
        h.update(&o.head);
        let mut n = o.head.len() as u64;
        let mut buf = vec![0u8; 65536];
        if !o.eof { loop { let k = o.reader.read(&mut buf).unwrap(); if k == 0 { break; } h.update(&buf[..k]); n += k as u64; } }
        let hex = format!("{:x}", h.finalize());
        eprintln!("winner {} -> {} bytes", o.candidate.id, n);
        verify(&o.candidate, o.header_version.as_deref(), n, &hex).unwrap();
    }

    #[test]
    fn encodes_names() {
        assert_eq!(encode("Coffee.CLI_3.9.2_Windows_x64-setup.exe"), "Coffee.CLI_3.9.2_Windows_x64-setup.exe");
        assert_eq!(encode("a b+c"), "a%20b%2Bc");
    }
}
