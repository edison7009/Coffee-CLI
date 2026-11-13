use super::buffers::{Buffers, Replay, TERMINAL_BYTES};
use super::secure::{Initiator, MODE_PAIR, MODE_RESUME};
use super::*;

pub static TEST_PAIRING_ANSWER: AtomicBool = AtomicBool::new(true);

/// Socket tests share one hub and one config file, so they run one at a time
/// against a config directory that lives for the whole test process.
fn socket_test_env() -> std::sync::MutexGuard<'static, ()> {
    static DIR: OnceLock<tempfile::TempDir> = OnceLock::new();
    static LOCK: Mutex<()> = Mutex::new(());
    let guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    config::use_path(DIR.get_or_init(|| tempfile::tempdir().unwrap()).path().join("config.json"));
    let mut settings = config::load();
    settings.devices.clear();
    config::save(&settings).unwrap();
    *hub().pairing.lock().unwrap() = None;
    TEST_PAIRING_ANSWER.store(true, Ordering::SeqCst);
    hub().enabled.store(true, Ordering::SeqCst);
    guard
}

fn spawn_test_server(runtime: &tokio::runtime::Runtime) -> SocketAddr {
    runtime.block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { loop { let (stream, _) = listener.accept().await.unwrap(); tokio::spawn(serve(stream)); } });
        addr
    })
}

#[test]
fn terminal_buffer_keeps_the_newest_bytes_on_char_boundaries() {
    let mut b = Buffers::default();
    b.push_terminal("t", &"咖".repeat(TERMINAL_BYTES / 3 + 10));
    b.push_terminal("t", "end");
    let Replay::Terminal(snapshot) = b.replay("t") else { panic!("terminal replay") };
    assert!(snapshot.len() <= TERMINAL_BYTES && snapshot.ends_with("end"));
    assert!(snapshot.starts_with('咖'));
}

#[test]
fn a_new_generation_discards_the_previous_conversation() {
    let mut b = Buffers::default();
    b.push_conversation("c", "claude", "g1", json!({"type":"a"}));
    b.push_conversation("c", "claude", "g1", json!({"type":"b"}));
    b.push_conversation("c", "claude", "g2", json!({"type":"c"}));
    assert_eq!(b.replay("c"), Replay::Conversation { kind: "claude".into(), generation: "g2".into(), events: vec![json!({"type":"c"})] });
    assert_eq!(b.replay("missing"), Replay::Empty);
}

#[test]
fn old_sessions_are_evicted() {
    let mut b = Buffers::default();
    for i in 0..(buffers::MAX_SESSIONS + 5) { b.push_terminal(&format!("s{i}"), "x"); }
    assert_eq!(b.replay("s0"), Replay::Empty);
    assert!(matches!(b.replay(&format!("s{}", buffers::MAX_SESSIONS + 4)), Replay::Terminal(_)));
}

#[test]
fn config_generates_a_key_pair_and_defaults_off() {
    let (settings, fresh) = config::parse(None);
    assert!(fresh && !settings.enabled && settings.port == config::DEFAULT_PORT);
    assert_eq!((settings.private_bytes().len(), hex::decode(&settings.public_key).unwrap().len()), (32, 32));
    let (kept, fresh) = config::parse(Some(&serde_json::to_string(&settings).unwrap()));
    assert!(!fresh && kept.private_key == settings.private_key);
    // A damaged key pair is replaced, and the pairings bound to it are dropped.
    let mut broken = settings.clone();
    broken.private_key = "zz".into();
    broken.devices.push(config::Device { public_key: "aa".into(), name: "p".into(), paired_at: 0 });
    let (healed, fresh) = config::parse(Some(&serde_json::to_string(&broken).unwrap()));
    assert!(fresh && healed.devices.is_empty() && healed.private_key != settings.private_key);
}

#[test]
fn hello_requires_method_and_protocol() {
    let ok = json!({"id":1,"method":"hello","params":{"protocol":PROTOCOL}});
    assert_eq!(check_hello(&ok).unwrap()["protocol"], PROTOCOL);
    assert_eq!(check_hello(&json!({"method":"ping"})).unwrap_err()["code"], "unauthorized");
    assert_eq!(check_hello(&json!({"method":"hello","params":{"protocol":99}})).unwrap_err()["code"], "unsupported");
}

#[test]
fn channel_round_trips_large_and_empty_frames_and_rejects_tampering() {
    let (desktop_private, desktop_public) = secure::generate_keypair();
    let (phone_private, phone_public) = secure::generate_keypair();
    let mut phone = Initiator::new(&phone_private, &desktop_public, &[0; 32]).unwrap();
    let first = phone.first_message(MODE_RESUME).unwrap();
    let (msg2, remote, desktop) = secure::respond(&desktop_private, &first[1..], &[0; 32]).unwrap();
    assert_eq!(remote, phone_public);
    let phone = phone.finish(&msg2).unwrap();

    let big = "咖啡".repeat(100_000);
    assert_eq!(desktop.decrypt(&phone.encrypt(big.as_bytes()).unwrap()).unwrap(), big.as_bytes());
    assert_eq!(phone.decrypt(&desktop.encrypt(b"").unwrap()).unwrap(), b"");
    let mut sealed = phone.encrypt(b"hello").unwrap();
    *sealed.last_mut().unwrap() ^= 1;
    assert!(desktop.decrypt(&sealed).is_err(), "tampered frame is rejected");
}

#[test]
fn wrong_pairing_code_fails_the_handshake() {
    let (desktop_private, desktop_public) = secure::generate_keypair();
    let (phone_private, _) = secure::generate_keypair();
    let mut phone = Initiator::new(&phone_private, &desktop_public, &secure::pairing_psk("guess")).unwrap();
    let first = phone.first_message(MODE_PAIR).unwrap();
    // The responder cannot tell yet; the phone fails on the reply, and the
    // desktop fails on the phone's first frame.
    let (msg2, _, desktop) = secure::respond(&desktop_private, &first[1..], &secure::pairing_psk("real")).unwrap();
    assert!(phone.finish(&msg2).is_err());
    assert!(desktop.decrypt(&[0, 17, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).is_err());
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

async fn recv_binary(ws: &mut Ws) -> Option<Vec<u8>> {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), ws.next()).await.ok()?? {
            Ok(Message::Binary(b)) => return Some(b.to_vec()),
            Ok(Message::Close(_)) | Err(_) => return None,
            _ => {}
        }
    }
}

struct Phone { ws: Ws, channel: secure::Channel }
impl Phone {
    async fn send(&mut self, v: Value) { self.ws.send(Message::binary(self.channel.encrypt(v.to_string().as_bytes()).unwrap())).await.unwrap(); }
    async fn recv(&mut self) -> Option<Value> { serde_json::from_slice(&self.channel.decrypt(&recv_binary(&mut self.ws).await?).ok()?).ok() }
}

/// Opens a socket and runs the handshake plus `hello`. `None` when the desktop
/// drops the connection.
async fn connect(url: &str, private: &[u8], desktop_public: &[u8], mode: u8, psk: [u8; 32]) -> Option<(Phone, Value)> {
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    let mut init = Initiator::new(private, desktop_public, &psk).unwrap();
    ws.send(Message::binary(init.first_message(mode).unwrap())).await.ok()?;
    let msg2 = recv_binary(&mut ws).await?;
    let channel = init.finish(&msg2).ok()?;
    let mut phone = Phone { ws, channel };
    phone.send(json!({"id":1,"method":"hello","params":{"protocol":PROTOCOL,"deviceName":"Test phone"}})).await;
    let reply = phone.recv().await?;
    Some((phone, reply))
}

/// End to end over a real socket: pairing with the one-time code, reconnect
/// with the device key, unknown and revoked phones dropped, encrypted
/// subscribe replay and live events.
#[test]
fn encrypted_websocket_round_trip() {
    let _env = socket_test_env();
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let url = format!("ws://{}", spawn_test_server(&runtime));
    runtime.block_on(async {
        let desktop_public = hex::decode(config::load().public_key).unwrap();
        let (phone_private, phone_public) = secure::generate_keypair();

        // Not paired yet: a resume attempt is dropped before any reply.
        assert!(connect(&url, &phone_private, &desktop_public, MODE_RESUME, [0; 32]).await.is_none());

        // Pairing without an open window, or with the wrong code, fails and burns the code.
        assert!(connect(&url, &phone_private, &desktop_public, MODE_PAIR, secure::pairing_psk("x")).await.is_none());
        *hub().pairing.lock().unwrap() = Some(("real".into(), Instant::now() + PAIRING_TTL));
        assert!(connect(&url, &phone_private, &desktop_public, MODE_PAIR, secure::pairing_psk("wrong")).await.is_none());
        assert!(hub().pairing.lock().unwrap().is_none(), "a failed attempt consumes the code");

        // The desktop declines: nothing is registered.
        TEST_PAIRING_ANSWER.store(false, Ordering::SeqCst);
        *hub().pairing.lock().unwrap() = Some(("real".into(), Instant::now() + PAIRING_TTL));
        assert!(connect(&url, &phone_private, &desktop_public, MODE_PAIR, secure::pairing_psk("real")).await.unwrap().1["error"]["code"] == "unauthorized");
        assert!(config::load().devices.is_empty());
        TEST_PAIRING_ANSWER.store(true, Ordering::SeqCst);

        *hub().pairing.lock().unwrap() = Some(("real".into(), Instant::now() + PAIRING_TTL));
        let (mut paired, hello) = connect(&url, &phone_private, &desktop_public, MODE_PAIR, secure::pairing_psk("real")).await.expect("pairing succeeds");
        assert_eq!(hello["result"]["protocol"], PROTOCOL);
        let device = &config::load().devices[0];
        assert_eq!((device.public_key.as_str(), device.name.as_str()), (hex::encode(&phone_public).as_str(), "Test phone"));
        drop(paired.ws.close(None).await);

        // Reconnect with the device key.
        let (mut phone, _) = connect(&url, &phone_private, &desktop_public, MODE_RESUME, [0; 32]).await.expect("paired phone reconnects");
        phone.send(json!({"id":2,"method":"ping","params":{}})).await;
        assert!(phone.recv().await.unwrap()["result"]["t"].is_i64());
        phone.send(json!({"id":3,"method":"nope","params":{}})).await;
        assert_eq!(phone.recv().await.unwrap()["error"]["code"], "unsupported");

        record_conversation("codex", json!({"id":"rt-conv","generation":"g","event":{"type":"first"}}));
        phone.send(json!({"id":4,"method":"session.subscribe","params":{"id":"rt-conv"}})).await;
        let replay = phone.recv().await.unwrap();
        assert_eq!((replay["result"]["view"].as_str(), &replay["result"]["events"]), (Some("conversation"), &json!([{"type":"first"}])));
        record_terminal("rt-other", "not subscribed");
        record_conversation("codex", json!({"id":"rt-conv","generation":"g","event":{"type":"second"}}));
        let live = phone.recv().await.unwrap();
        assert_eq!((live["event"].as_str(), live["params"]["payload"]["type"].as_str()), (Some("conversation.event"), Some("second")));

        // A tampered frame ends the connection.
        let mut sealed = phone.channel.encrypt(json!({"id":5,"method":"ping"}).to_string().as_bytes()).unwrap();
        sealed[3] ^= 0xff;
        let tampered_at = Instant::now();
        phone.ws.send(Message::binary(sealed)).await.unwrap();
        assert!(recv_binary(&mut phone.ws).await.is_none());
        assert!(tampered_at.elapsed() < Duration::from_secs(2), "tampering closes the socket at once");

        // Revocation drops live connections and blocks reconnecting.
        let (mut live_phone, _) = connect(&url, &phone_private, &desktop_public, MODE_RESUME, [0; 32]).await.unwrap();
        let revoked_at = Instant::now();
        mobile_rpc_revoke_device(hex::encode(&phone_public)).unwrap();
        assert!(recv_binary(&mut live_phone.ws).await.is_none(), "revoked phone is disconnected");
        assert!(revoked_at.elapsed() < Duration::from_secs(2), "disconnect is immediate, not a timeout");
        assert!(connect(&url, &phone_private, &desktop_public, MODE_RESUME, [0; 32]).await.is_none());
    });
}

/// The phone app's own protocol code (mobile/src/protocol.ts, run by Node)
/// against this server: pairing, a frame larger than one Noise message,
/// replay, a live event and a stranger being refused. Skipped when Node or the
/// mobile dependencies are not installed.
#[test]
fn mobile_app_protocol_interoperates() {
    use std::io::BufRead;
    let mobile = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("mobile");
    if !mobile.join("node_modules/@noble/curves").exists() || std::process::Command::new("node").arg("--version").output().is_err() {
        eprintln!("skipped: run `npm install` in mobile/ to check the app protocol");
        return;
    }
    let _env = socket_test_env();
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let addr = spawn_test_server(&runtime);
    *hub().pairing.lock().unwrap() = Some(("interop-code".into(), Instant::now() + PAIRING_TTL));
    let mut child = std::process::Command::new("node")
        .args(["--no-warnings", "scripts/noise-interop.mjs", "127.0.0.1", &addr.port().to_string(), &config::load().public_key, "interop-code"])
        .current_dir(&mobile).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::inherit()).spawn().unwrap();
    let mut lines = std::io::BufReader::new(child.stdout.take().unwrap()).lines();
    let ready: Value = serde_json::from_str(&lines.next().expect("ready line").unwrap()).unwrap();
    assert_eq!(ready["ready"], true);
    record_conversation("pi", json!({"id":"interop-conv","generation":"g1","event":{"type":"agent_start"}}));
    let out: Value = serde_json::from_str(&lines.next().expect("result line").unwrap()).unwrap();
    assert!(child.wait().unwrap().success());
    assert_eq!(out["hello"], PROTOCOL);
    assert_eq!(out["host"], "127.0.0.1", "raced past the unreachable first address");
    assert_eq!(out["ping"], "number");
    assert_eq!(out["bigError"], "invalid_params", "a 200 KB request decrypted and was validated");
    assert_eq!(out["subscribe"]["view"], Value::Null);
    assert_eq!(out["event"]["event"], "conversation.event");
    assert_eq!(out["event"]["params"]["payload"]["type"], "agent_start");
    assert_eq!(out["stranger"], "unauthorized");
    assert_eq!(config::load().devices.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(), ["Interop phone"]);
}

#[test]
fn addresses_skip_proxies_tunnels_and_bridges() {
    use network::{rank_candidates, Kind, Raw};
    let raw = |name, o: [u8; 4], p2p| Raw { name, ip: Ipv4Addr::from(o), point_to_point: p2p, up: true };
    let wifi = vec!["en0".to_string()];
    // A proxy in TUN mode owns the default route with 198.18.0.1; Wi-Fi comes first.
    let list = rank_candidates(&[raw("utun4", [198, 18, 0, 1], true), raw("en1", [192, 168, 10, 80], false), raw("en0", [192, 168, 10, 79], false), raw("lo0", [127, 0, 0, 1], false)], &wifi);
    assert_eq!(list.iter().map(|c| (c.address.as_str(), c.kind)).collect::<Vec<_>>(), [("192.168.10.79", Kind::Wifi), ("192.168.10.80", if cfg!(target_os = "macos") { Kind::Ethernet } else { Kind::Other })]);
    // Proxy adapters with private addresses, any point-to-point tunnel, Docker and link-local are hidden; Tailscale is kept after LAN.
    let list = rank_candidates(&[raw("Clash", [172, 19, 0, 1], false), raw("tun0", [10, 8, 0, 2], true), raw("docker0", [172, 17, 0, 1], false), raw("eth0", [10, 0, 0, 5], false), raw("en5", [169, 254, 3, 4], false), raw("tailscale0", [100, 101, 1, 2], false)], &[]);
    assert_eq!(list.iter().map(|c| (c.address.as_str(), c.kind)).collect::<Vec<_>>(), [("10.0.0.5", Kind::Ethernet), ("100.101.1.2", Kind::Tailscale)]);
    let list = rank_candidates(&[raw("以太网", [192, 168, 1, 20], false), raw("vEthernet (WSL)", [172, 30, 0, 1], false), raw("WLAN", [192, 168, 1, 21], false)], &[]);
    assert_eq!(list.iter().map(|c| (c.interface.as_str(), c.kind)).collect::<Vec<_>>(), [("WLAN", Kind::Wifi), ("以太网", Kind::Ethernet)]);
    // A disconnected adapter is not offered.
    assert!(rank_candidates(&[Raw { name: "en0", ip: Ipv4Addr::new(192, 168, 1, 2), point_to_point: false, up: false }], &wifi).is_empty());
}

#[test]
fn advertised_hosts_put_the_choice_first_and_end_with_the_local_name() {
    use network::{advertised_hosts, Candidate, Kind};
    let c = |a: &str, k| Candidate { address: a.into(), interface: "x".into(), kind: k };
    let list = [c("192.168.1.2", Kind::Wifi), c("10.0.0.3", Kind::Ethernet), c("100.100.1.1", Kind::Tailscale), c("172.20.0.4", Kind::Other)];
    assert_eq!(advertised_hosts(&list, None, Some("mac.local")), ["192.168.1.2", "10.0.0.3", "100.100.1.1", "mac.local"]);
    assert_eq!(advertised_hosts(&list, Some("100.100.1.1"), None), ["100.100.1.1", "192.168.1.2", "10.0.0.3"]);
    // A choice that disappeared falls back to the automatic order.
    assert_eq!(advertised_hosts(&list, Some("192.168.9.9"), None)[0], "192.168.1.2");
    // No network: no QR code, not just a .local name.
    assert!(advertised_hosts(&[], None, Some("mac.local")).is_empty());
}

#[test]
fn hardware_ports_find_wifi_devices() {
    let text = "Hardware Port: Ethernet\nDevice: en0\nEthernet Address: aa\n\nHardware Port: Wi-Fi\nDevice: en1\nEthernet Address: bb\n\nHardware Port: Thunderbolt Bridge\nDevice: bridge0\n";
    assert_eq!(network::parse_hardware_ports(text), ["en1"]);
}

#[test]
fn firewall_decision_follows_windows_rule_precedence() {
    use firewall::{decide, Rule, Snapshot, State};
    let rule = |enabled, action: &str, profile: &str| Rule { enabled, action: action.into(), profile: profile.into() };
    let snap = |rules, cats: &[&str]| Snapshot { rules, categories: cats.iter().map(|c| c.to_string()).collect() };
    assert_eq!(decide(&snap(vec![rule(true, "Allow", "Private")], &["Private"])), State::Open);
    assert_eq!(decide(&snap(vec![rule(true, "Allow", "Any")], &["DomainAuthenticated"])), State::Open);
    // A block rule for the same profile wins; a disabled one does not count.
    assert_eq!(decide(&snap(vec![rule(true, "Allow", "Private"), rule(true, "Block", "Private, Public")], &["Private"])), State::Blocked);
    assert_eq!(decide(&snap(vec![rule(true, "Allow", "Private"), rule(false, "Block", "Private")], &["Private"])), State::Open);
    // No rule yet (first-run prompt dismissed or pending) is blocked on a private network.
    assert_eq!(decide(&snap(vec![], &["Private"])), State::Blocked);
    // On a public network only: point to the network setting rather than opening it.
    assert_eq!(decide(&snap(vec![rule(true, "Allow", "Private")], &["Public"])), State::PublicNetwork);
    assert_eq!(decide(&snap(vec![rule(true, "Allow", "Public")], &["Public"])), State::Open);
    assert_eq!(decide(&snap(vec![], &[])), State::Unknown);
}

#[test]
fn firewall_scripts_quote_the_program_path() {
    let exe = r"C:\Users\O'Brien\AppData\Local\Coffee CLI\coffee-cli.exe";
    let check = firewall::check_script(exe);
    assert!(check.contains(r"-Program 'C:\Users\O''Brien\AppData\Local\Coffee CLI\coffee-cli.exe'"));
    let allow = firewall::allow_script(exe, 47391);
    assert!(allow.contains("-LocalPort 47391 -Action Allow -Profile Private,Domain"));
    assert!(allow.contains("Remove-NetFirewallRule") && !allow.contains("Public"));
    // UTF-16LE base64, as -EncodedCommand expects.
    assert_eq!(firewall::encode_command("ab"), "YQBiAA==");
}

#[test]
fn browser_commands_are_denied_or_scoped_to_own_sessions() {
    use std::collections::HashSet;
    let mut owned = HashSet::new();
    let ok = |cmd: &str, args: Value, owned: &mut HashSet<String>| remote_ui::check(cmd, &args, owned).is_ok();
    // Everyday desktop features pass through.
    for cmd in ["list_directory", "get_usage_statistics", "git_changes", "load_tasks", "get_native_history", "list_tools", "claude_session_preview"] { assert!(ok(cmd, json!({}), &mut owned), "{cmd}"); }
    // The desktop window, host devices, credentials, pairing, installers and the agent hub are not.
    for cmd in ["window_close", "pick_folder", "show_in_folder", "load_password", "save_password", "mobile_rpc_set_enabled", "mobile_rpc_revoke_device", "voice_input_start", "download_and_install_update", "update_cli", "orchestration_sync", "agent_resolve_tool", "start_fs_watcher", "plugin:dialog|open", "Window_Close", "a;b", ""] {
        assert!(!ok(cmd, json!({}), &mut owned), "{cmd}");
    }
    // A browser drives only what it started.
    assert!(!ok("claude_session_send", json!({"id":"desk"}), &mut owned), "desktop session");
    assert!(!ok("tier_terminal_input", json!({"sessionId":"desk-term"}), &mut owned));
    assert!(!ok("codex_session_close", json!({"id":"desk"}), &mut owned));
    assert!(ok("claude_session_start", json!({"id":"web-1"}), &mut owned));
    assert!(ok("claude_session_send", json!({"id":"web-1"}), &mut owned));
    assert!(ok("claude_session_close", json!({"id":"web-1"}), &mut owned));
    assert!(ok("tier_terminal_start", json!({"sessionId":"web-t"}), &mut owned));
    assert!(ok("tier_terminal_resize", json!({"sessionId":"web-t"}), &mut owned));
    assert!(!ok("tier_terminal_kill", json!({"sessionId":"web-1-other"}), &mut owned));
    assert!(!ok("pi_session_start", json!({}), &mut owned), "start needs an id");
}

#[test]
fn web_requests_are_classified_and_paths_confined() {
    use web::{classify, route, Request, Route};
    assert!(matches!(classify(b"GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade"), Request::Upgrade));
    assert!(matches!(classify(b"GET /assets/a.js HTTP/1.1\r\nHost: x"), Request::Get(t) if t == "/assets/a.js"));
    assert!(matches!(classify(b"POST / HTTP/1.1\r\nHost: x"), Request::Other));
    assert!(matches!(route("/"), Some(Route::Redirect("/?remote"))));
    assert!(matches!(route("/?remote"), Some(Route::File(p)) if p == "index.html"));
    assert!(matches!(route("/assets/index-1.js?v=2"), Some(Route::File(p)) if p == "assets/index-1.js"));
    for bad in ["/../secret", "/assets/../../etc/passwd", "/a//b", "/%2e%2e/x", "/a\\b"] { assert!(route(bad).is_none(), "{bad}"); }
}
