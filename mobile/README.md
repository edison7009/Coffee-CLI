# Coffee CLI Mobile

Expo (SDK 58) companion app: pair with Coffee CLI on your computer, see its sessions,
follow conversations rendered by the desktop's own reducers, and send messages.
Protocol: [PROTOCOL.md](PROTOCOL.md). Desktop side: `src/mobile_rpc/`.

## Layout

- `src/protocol.ts` — Noise `IKpsk2` initiator, framed encryption and the RPC client.
  Imports only `@noble/*`, so Node runs it directly for tests.
- `src/conversation.ts` — applies desktop session events with
  `src-ui/src/shared/conversation` (bundled through `metro.config.js`).
- `src/connection.tsx` — pairing record, connect, reconnect with backoff.
- `src/screens/` — pair (QR scan or pasted link), sessions, session.

## Commands (run in `mobile/`)

```bash
npm install
npm run typecheck
npm test            # protocol unit tests
npm run web         # browser preview (no camera: paste the pairing link)
npm run ios         # needs Xcode
npm run android     # needs Android Studio
```

The desktop interop test runs with `cargo test mobile_rpc` from the repository
root once `mobile/node_modules` exists; it drives `scripts/noise-interop.mjs`
against the real Rust server.
