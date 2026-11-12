use super::buffers::{Buffers, Replay, TERMINAL_BYTES};
use super::*;

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
fn config_generates_a_token_and_defaults_off() {
    let (settings, fresh) = config::parse(None);
    assert!(fresh && !settings.enabled && settings.port == config::DEFAULT_PORT && settings.token.len() == 64);
    let (kept, fresh) = config::parse(Some(&serde_json::to_string(&settings).unwrap()));
    assert!(!fresh && kept.token == settings.token);
    let (broken, fresh) = config::parse(Some("{not json"));
    assert!(fresh && !broken.enabled);
}

#[test]
fn token_check_rejects_wrong_and_empty_tokens() {
    assert!(config::token_matches("abc", "abc"));
    assert!(!config::token_matches("abd", "abc"));
    assert!(!config::token_matches("", ""));
}

#[test]
fn hello_requires_method_protocol_and_token() {
    let ok = json!({"id":1,"method":"hello","params":{"protocol":PROTOCOL,"token":"secret"}});
    assert_eq!(check_hello(&ok, "secret").unwrap()["protocol"], PROTOCOL);
    assert_eq!(check_hello(&json!({"method":"ping"}), "secret").unwrap_err()["code"], "unauthorized");
    let wrong_token = json!({"method":"hello","params":{"protocol":PROTOCOL,"token":"nope"}});
    assert_eq!(check_hello(&wrong_token, "secret").unwrap_err()["code"], "unauthorized");
    let future = json!({"method":"hello","params":{"protocol":99,"token":"secret"}});
    assert_eq!(check_hello(&future, "secret").unwrap_err()["code"], "unsupported");
}

/// Real socket round trip: unauthenticated clients are dropped; an
/// authenticated one gets ping, a replay on subscribe and live output.
#[test]
fn websocket_round_trip() {
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        hub().enabled.store(true, Ordering::SeqCst);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop { let (stream, _) = listener.accept().await.unwrap(); tokio::spawn(async move { serve(stream, "secret").await }); }
        });
        let url = format!("ws://{addr}");
        let send = |v: Value| Message::text(v.to_string());
        async fn recv(ws: &mut (impl StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin)) -> Option<Value> {
            loop {
                match tokio::time::timeout(Duration::from_secs(5), ws.next()).await.ok()?? {
                    Ok(Message::Text(t)) => return serde_json::from_str(&t).ok(),
                    Ok(Message::Close(_)) | Err(_) => return None,
                    _ => {}
                }
            }
        }

        let (mut bad, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        bad.send(send(json!({"id":1,"method":"hello","params":{"protocol":PROTOCOL,"token":"wrong"}}))).await.unwrap();
        assert_eq!(recv(&mut bad).await.unwrap()["error"]["code"], "unauthorized");
        assert!(recv(&mut bad).await.is_none(), "rejected client is disconnected");

        let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        ws.send(send(json!({"id":1,"method":"hello","params":{"protocol":PROTOCOL,"token":"secret"}}))).await.unwrap();
        assert_eq!(recv(&mut ws).await.unwrap()["result"]["protocol"], PROTOCOL);
        ws.send(send(json!({"id":2,"method":"ping","params":{}}))).await.unwrap();
        assert!(recv(&mut ws).await.unwrap()["result"]["t"].is_i64());
        ws.send(send(json!({"id":3,"method":"nope","params":{}}))).await.unwrap();
        assert_eq!(recv(&mut ws).await.unwrap()["error"]["code"], "unsupported");

        record_conversation("codex", json!({"id":"rt-conv","generation":"g","event":{"type":"first"}}));
        ws.send(send(json!({"id":4,"method":"session.subscribe","params":{"id":"rt-conv"}}))).await.unwrap();
        let replay = recv(&mut ws).await.unwrap();
        assert_eq!(replay["result"]["view"], "conversation");
        assert_eq!(replay["result"]["events"], json!([{"type":"first"}]));
        record_conversation("codex", json!({"id":"rt-conv","generation":"g","event":{"type":"second"}}));
        let live = recv(&mut ws).await.unwrap();
        assert_eq!((live["event"].as_str(), live["params"]["payload"]["type"].as_str()), (Some("conversation.event"), Some("second")));
        // Output for sessions the phone did not subscribe to is not sent.
        record_terminal("rt-other", "hidden");
        record_terminal("rt-conv-missing", "hidden");
        ws.send(send(json!({"id":5,"method":"ping","params":{}}))).await.unwrap();
        assert_eq!(recv(&mut ws).await.unwrap()["id"], 5);
    });
}
