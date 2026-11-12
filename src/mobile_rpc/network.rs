//! Which addresses a phone on the same network can dial.
//!
//! The default route is not trusted: a proxy or VPN in TUN mode owns it, and
//! its address (often 198.18.0.1) is unreachable from a phone. Instead every
//! interface is listed, tunnels and host-only bridges are hidden, and the rest
//! are labelled so a person can pick one when the automatic choice is wrong.

use serde::Serialize;
use std::net::Ipv4Addr;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind { Wifi, Ethernet, Tailscale, Other }

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub address: String,
    pub interface: String,
    pub kind: Kind,
}

/// What the OS reports for one IPv4 interface address.
pub struct Raw<'a> { pub name: &'a str, pub ip: Ipv4Addr, pub point_to_point: bool, pub up: bool }

const BRIDGES: [&str; 17] = ["docker", "br-", "virbr", "vmnet", "vboxnet", "veth", "lxcbr", "cni", "flannel", "cali", "bridge", "awdl", "llw", "anpi", "ap1", "vmware network adapter", "virtualbox host-only"];
const TUNNELS: [&str; 8] = ["utun", "tun", "tap", "wg", "ppp", "ipsec", "gif", "stf"];
/// Proxy and VPN adapter names that carry private addresses but no LAN route.
const PROXY_WORDS: [&str; 8] = ["clash", "mihomo", "meta", "sing-box", "singbox", "wintun", "v2ray", "xray"];

fn is_tailnet(ip: Ipv4Addr) -> bool { let o = ip.octets(); o[0] == 100 && (64..128).contains(&o[1]) }

/// `None` hides the address: unreachable from a phone, or host-only.
pub fn classify(raw: &Raw, wifi_devices: &[String]) -> Option<Kind> {
    let name = raw.name.to_ascii_lowercase();
    let o = raw.ip.octets();
    if !raw.up || raw.ip.is_loopback() || raw.ip.is_link_local() || raw.ip.is_unspecified() || raw.ip.is_multicast() { return None; }
    // 198.18.0.0/15 is the benchmark range proxy fake-IP modes hand out.
    if o[0] == 198 && (o[1] & 0xfe) == 18 { return None; }
    if is_tailnet(raw.ip) && (name.contains("tailscale") || name.starts_with("utun") || name.starts_with("tun") || raw.point_to_point) { return Some(Kind::Tailscale); }
    if BRIDGES.iter().any(|b| name.starts_with(b) || name.contains(b))
        // Hyper-V/WSL switches are host-only unless they hold the default route, which we cannot see here.
        || name.starts_with("vethernet")
        || PROXY_WORDS.iter().any(|w| name.contains(w))
        || TUNNELS.iter().any(|t| name.starts_with(t))
        || raw.point_to_point { return None; }
    let wifi = wifi_devices.iter().any(|d| d.eq_ignore_ascii_case(raw.name))
        || name.starts_with("wl") || name.contains("wi-fi") || name.contains("wifi") || name.contains("wlan") || raw.name.contains("无线");
    if wifi { return Some(Kind::Wifi); }
    let wired = name.starts_with("eth") || name.starts_with("enp") || name.starts_with("eno") || name.contains("ethernet") || raw.name.contains("以太网")
        // macOS names both en*; whatever is not Wi-Fi is wired (or a USB/Thunderbolt adapter).
        || (cfg!(target_os = "macos") && name.starts_with("en"));
    Some(if wired { Kind::Ethernet } else { Kind::Other })
}

/// Private LAN ranges first, Wi-Fi and Ethernet before the rest, Tailscale after LAN.
fn rank(c: &Candidate) -> (u8, u8, String) {
    let ip: Ipv4Addr = c.address.parse().unwrap_or(Ipv4Addr::UNSPECIFIED);
    let private = match ip.octets() { [192, 168, ..] => 0, [10, ..] => 1, [172, b, ..] if (16..32).contains(&b) => 2, _ => 3 };
    let kind = match c.kind { Kind::Wifi | Kind::Ethernet => 0, Kind::Tailscale => 1, Kind::Other => 2 };
    (kind, private, c.interface.to_ascii_lowercase())
}

pub fn rank_candidates(raws: &[Raw], wifi_devices: &[String]) -> Vec<Candidate> {
    let mut list: Vec<Candidate> = raws.iter().filter_map(|raw| classify(raw, wifi_devices).map(|kind| Candidate { address: raw.ip.to_string(), interface: raw.name.to_owned(), kind })).collect();
    list.sort_by_key(rank);
    list.dedup_by(|a, b| a.address == b.address);
    list
}

/// The addresses a pairing QR code carries, best first: the person's choice
/// when it is still present, then up to two other LAN candidates, then the
/// computer's `.local` name so a phone can follow a changed DHCP address.
pub fn advertised_hosts(candidates: &[Candidate], preferred: Option<&str>, local_name: Option<&str>) -> Vec<String> {
    let mut hosts: Vec<String> = Vec::new();
    if let Some(p) = preferred.filter(|p| candidates.iter().any(|c| c.address == *p)) { hosts.push(p.to_owned()); }
    for c in candidates {
        if hosts.len() >= 3 { break; }
        if !hosts.contains(&c.address) { hosts.push(c.address.clone()); }
    }
    if let Some(name) = local_name.filter(|_| !hosts.is_empty()) { hosts.push(name.to_owned()); }
    hosts
}

/// Wi-Fi device names on macOS (`en0`, …), which `en*` alone cannot tell apart from Ethernet.
fn wifi_devices() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        use std::sync::OnceLock;
        static CACHE: OnceLock<Vec<String>> = OnceLock::new();
        return CACHE.get_or_init(|| {
            let Ok(out) = std::process::Command::new("/usr/sbin/networksetup").arg("-listallhardwareports").output() else { return Vec::new() };
            parse_hardware_ports(&String::from_utf8_lossy(&out.stdout))
        }).clone();
    }
    #[allow(unreachable_code)]
    Vec::new()
}

pub fn parse_hardware_ports(text: &str) -> Vec<String> {
    let mut wifi = Vec::new();
    let mut port = "";
    for line in text.lines() {
        if let Some(p) = line.strip_prefix("Hardware Port: ") { port = p.trim(); }
        if let Some(device) = line.strip_prefix("Device: ") {
            if port.eq_ignore_ascii_case("Wi-Fi") || port.eq_ignore_ascii_case("AirPort") { wifi.push(device.trim().to_owned()); }
        }
    }
    wifi
}

pub fn candidates() -> Vec<Candidate> {
    let Ok(interfaces) = if_addrs::get_if_addrs() else { return Vec::new() };
    let raws: Vec<Raw> = interfaces.iter().filter_map(|i| match i.ip() {
        std::net::IpAddr::V4(ip) => Some(Raw { name: &i.name, ip, point_to_point: i.is_p2p, up: !matches!(i.oper_status, if_addrs::IfOperStatus::Down) }),
        _ => None,
    }).collect();
    rank_candidates(&raws, &wifi_devices())
}

/// The computer's mDNS name. macOS and Windows answer for it out of the box;
/// Linux only with Avahi, so it is not offered there.
pub fn local_name() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("/usr/sbin/scutil").args(["--get", "LocalHostName"]).output().ok()?;
        let name = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        return valid_label(&name).then(|| format!("{name}.local"));
    }
    #[cfg(windows)]
    {
        let name = std::env::var("COMPUTERNAME").ok()?;
        return valid_label(&name).then(|| format!("{}.local", name.to_ascii_lowercase()));
    }
    #[allow(unreachable_code)]
    None
}

fn valid_label(name: &str) -> bool { !name.is_empty() && name.len() <= 63 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') }
