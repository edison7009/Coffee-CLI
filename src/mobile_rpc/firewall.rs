//! Windows Defender Firewall: phones cannot connect while inbound traffic to
//! Coffee CLI is blocked. Checks the app's inbound rules against the active
//! network profile, and adds an allow rule (with the person's UAC consent)
//! for private networks. Public networks are left closed on purpose: the page
//! asks the person to mark a trusted network as private instead.

// Only Windows runs the checks; elsewhere the decision code is exercised by tests.
#![cfg_attr(not(windows), allow(dead_code))]

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    /// Not Windows, or nothing to do.
    Open,
    /// An enabled block rule, or no allow rule, covers the active profile.
    Blocked,
    /// The active network is Public; allowing there is not offered.
    PublicNetwork,
    /// The check itself failed.
    Unknown,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "PascalCase")]
pub struct Rule {
    pub enabled: bool,
    /// "Allow" or "Block".
    pub action: String,
    /// Comma list of "Domain", "Private", "Public", or "Any".
    pub profile: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Snapshot {
    #[serde(default)]
    pub rules: Vec<Rule>,
    /// Categories of the connected networks: "Public", "Private", "DomainAuthenticated".
    #[serde(default)]
    pub categories: Vec<String>,
}

fn covers(rule: &Rule, profile: &str) -> bool {
    rule.profile.split(',').map(str::trim).any(|p| p.eq_ignore_ascii_case("Any") || p.eq_ignore_ascii_case(profile))
}

/// Pure decision from what PowerShell reported.
pub fn decide(snapshot: &Snapshot) -> State {
    let profiles: Vec<&str> = snapshot.categories.iter().map(|c| if c.eq_ignore_ascii_case("DomainAuthenticated") { "Domain" } else { c.as_str() }).collect();
    if profiles.is_empty() { return State::Unknown; }
    let enabled = || snapshot.rules.iter().filter(|r| r.enabled);
    // Block rules win over allow rules in Windows Firewall.
    let blocked = |p: &str| enabled().any(|r| r.action.eq_ignore_ascii_case("Block") && covers(r, p));
    let allowed = |p: &str| enabled().any(|r| r.action.eq_ignore_ascii_case("Allow") && covers(r, p));
    if profiles.iter().any(|p| allowed(p) && !blocked(p)) { return State::Open; }
    if profiles.iter().all(|p| p.eq_ignore_ascii_case("Public")) { return State::PublicNetwork; }
    State::Blocked
}

/// PowerShell single-quoted literal.
fn quote(text: &str) -> String { format!("'{}'", text.replace('\'', "''")) }

pub fn check_script(exe: &str) -> String {
    format!(
        "$ErrorActionPreference='Stop';\
         $rules=@(Get-NetFirewallApplicationFilter -Program {exe} -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object {{ $_.Direction -eq 'Inbound' }} | ForEach-Object {{ [pscustomobject]@{{Enabled=($_.Enabled -eq 'True');Action=[string]$_.Action;Profile=[string]$_.Profile}} }});\
         $cats=@(Get-NetConnectionProfile | ForEach-Object {{ [string]$_.NetworkCategory }});\
         [pscustomobject]@{{Rules=$rules;Categories=$cats}} | ConvertTo-Json -Compress -Depth 3",
        exe = quote(exe)
    )
}

/// Removes the app's inbound block rules (a dismissed first-run prompt leaves
/// them) and allows TCP on the mobile port for private and domain networks.
pub fn allow_script(exe: &str, port: u16) -> String {
    format!(
        "Get-NetFirewallApplicationFilter -Program {exe} -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object {{ $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' }} | Remove-NetFirewallRule;\
         Get-NetFirewallRule -DisplayName 'Coffee CLI (phone)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule;\
         New-NetFirewallRule -DisplayName 'Coffee CLI (phone)' -Direction Inbound -Program {exe} -Protocol TCP -LocalPort {port} -Action Allow -Profile Private,Domain | Out-Null",
        exe = quote(exe)
    )
}

#[cfg(windows)]
fn powershell(script: &str) -> Result<std::process::Output, String> {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
pub fn status() -> State {
    let Ok(exe) = std::env::current_exe() else { return State::Unknown };
    let Ok(out) = powershell(&check_script(&exe.to_string_lossy())) else { return State::Unknown };
    // ConvertTo-Json turns one-element arrays into objects; normalise them.
    let text = String::from_utf8_lossy(&out.stdout);
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(text.trim()) else { return State::Unknown };
    for key in ["Rules", "Categories"] {
        if !value[key].is_array() && !value[key].is_null() { value[key] = serde_json::Value::Array(vec![value[key].take()]); }
    }
    serde_json::from_value::<Snapshot>(value).map_or(State::Unknown, |s| decide(&s))
}

#[cfg(not(windows))]
pub fn status() -> State { State::Open }

/// Runs the allow script elevated; Windows shows its own UAC prompt.
#[cfg(windows)]
pub fn allow(port: u16) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let inner = allow_script(&exe.to_string_lossy(), port);
    let outer = format!(
        "$p=Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand',{}; exit $p.ExitCode",
        quote(&encode_command(&inner))
    );
    let out = powershell(&outer)?;
    if out.status.success() { Ok(()) } else { Err("Windows did not allow the change".into()) }
}

#[cfg(not(windows))]
pub fn allow(_port: u16) -> Result<(), String> { Ok(()) }

/// `-EncodedCommand` takes base64 of UTF-16LE, which avoids every quoting layer.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn encode_command(script: &str) -> String {
    use base64::Engine;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
