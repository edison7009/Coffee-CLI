#!/usr/bin/env python3
# Coffee CLI — Codex Notify Forwarder
#
# Registered as `notify` in ~/.codex/config.toml by Coffee CLI at launch.
# Codex calls it once per significant event with the JSON payload appended
# as the FINAL argv argument (not stdin — see legacy_notify in
# codex-rs/hooks/src/legacy_notify.rs).
#
# Currently Codex only emits one event type:
#   {"type": "agent-turn-complete", ...}
# which we map to `idle` (turn finished, dot turns green).
#
# "working" state is NOT emitted by Codex — Codex is unique among our three
# integrated CLIs in only signalling turn completion, never turn start. The
# frontend (TierTerminal.tsx) compensates with an Enter-based optimistic
# update scoped to codex tabs, with a `/`-prefix filter so local slash
# commands don't strand the dot in working. Claude (UserPromptSubmit hook)
# and OpenCode (session.status) have real upstream signals and don't use
# the keypress shortcut.
#
# Env vars (injected by Coffee CLI when spawning Codex in a tab):
#   COFFEE_CLI_TAB_ID    — tab/session UUID
#   COFFEE_CLI_HOOK_PORT — loopback port of the Rust hook server
#   COFFEE_CLI_TOOL      — must be "codex" for this forwarder to fire
#
# IMPORTANT: `notify` is a *global* Codex config. This script also fires for
# Codex sessions started outside Coffee CLI (e.g. plain terminal), so it must
# no-op silently when env vars are missing or COFFEE_CLI_TOOL != "codex".
# Exit 0 on every path — a flaky notify must never block the agent turn.

import json
import os
import socket
import sys


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(0)
    try:
        data = json.loads(sys.argv[-1])
    except Exception:
        sys.exit(0)

    tab_id = os.environ.get("COFFEE_CLI_TAB_ID")
    port = os.environ.get("COFFEE_CLI_HOOK_PORT")
    tool = os.environ.get("COFFEE_CLI_TOOL", "")
    if not tab_id or not port or tool != "codex":
        sys.exit(0)

    event = data.get("type", "")
    if event == "agent-turn-complete":
        status = "idle"
    else:
        # Future-proof: unknown event types are ignored, not guessed.
        sys.exit(0)

    # File-edit attribution per tool was removed in v2.7.x. Codex no
    # longer needs to ship cwd in the payload — ChangesBoard's
    # `compute_folder_stats` polls based on the active tab's folder.
    payload = {
        "tab_id": tab_id,
        "tool": tool,
        "status": status,
        "event": event,
    }

    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(1.0)
        s.connect(("127.0.0.1", int(port)))
        s.sendall((json.dumps(payload) + "\n").encode("utf-8"))
        try:
            s.recv(256)
        except Exception:
            pass
        s.close()
    except Exception:
        pass

    sys.exit(0)


if __name__ == "__main__":
    main()
