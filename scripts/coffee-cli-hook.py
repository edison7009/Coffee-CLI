#!/usr/bin/env python3
# Coffee CLI Hook Forwarder
#
# Registered in ~/.claude/settings.json and ~/.qwen/settings.json by Coffee CLI
# at launch. Receives hook events on stdin (Claude Code / Qwen Code format),
# maps them to Coffee CLI's 3-state agent status, and forwards a compact JSON
# payload to the Coffee CLI backend over local TCP.
#
# Env vars (injected by Coffee CLI when spawning Claude/Qwen in a tab):
#   COFFEE_CLI_TAB_ID    — tab/session UUID the agent belongs to
#   COFFEE_CLI_HOOK_PORT — loopback port of the Rust hook server
#   COFFEE_CLI_TOOL      — "claude" | "qwen"
#
# Exit 0 silently on any error. A flaky hook must never block the agent.

import json
import os
import socket
import sys


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tab_id = os.environ.get("COFFEE_CLI_TAB_ID")
    port = os.environ.get("COFFEE_CLI_HOOK_PORT")
    tool = os.environ.get("COFFEE_CLI_TOOL", "")
    if not tab_id or not port:
        sys.exit(0)

    event = data.get("hook_event_name", "")
    status = None

    if event in (
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "PostToolUseFailure",
        "SubagentStart",
        "SubagentStop",
        "PreCompact",
        "PostCompact",
    ):
        status = "executing"
    elif event in ("Stop", "StopFailure", "SessionEnd"):
        status = "idle"
    elif event == "SessionStart":
        status = "idle"
    elif event == "PermissionRequest":
        status = "wait_input"
    elif event == "Notification":
        # Claude Code may expose the notification subtype under different keys
        ntype = (
            data.get("notification_type")
            or data.get("type")
            or (data.get("notification") or {}).get("type")
        )
        if ntype == "permission_prompt":
            status = "wait_input"
        elif ntype == "idle_prompt":
            status = "idle"

    if status is None:
        sys.exit(0)

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
