"""Coffee CLI status forwarder — Hermes Agent plugin.

Registered into ~/.hermes/plugins/coffee-cli-status/ by Coffee CLI at
launch. Subscribes to Hermes lifecycle hooks and forwards a compact
JSON status payload over local TCP to Coffee CLI's hook server, which
in turn drives the per-tab dot indicator.

Status mapping:
  on_session_start         → idle              (session just spawned)
  pre_llm_call             → working           (model is thinking)
  pre_tool_call            → working           (model is invoking a tool)
  post_llm_call            → idle              (turn complete)
  pre_approval_request     → wait_input        (dangerous op, user must approve)
  post_approval_response   → working           (user responded, agent resumes)
  on_session_end           → idle              (graceful close)

No-ops when COFFEE_CLI_TAB_ID / COFFEE_CLI_HOOK_PORT env vars are
absent — i.e. Hermes was launched outside Coffee CLI. Same env-var
no-op gate as the Codex notify forwarder and the OpenCode plugin, so
this plugin is safe to leave installed even when the user runs Hermes
standalone.

Crash policy: every TCP send is wrapped — exceptions are silently
swallowed. A flaky dynamic island must never break the agent.
"""

import json
import os
import socket


def _post(payload: dict) -> None:
    tab_id = os.environ.get("COFFEE_CLI_TAB_ID")
    port = os.environ.get("COFFEE_CLI_HOOK_PORT")
    if not tab_id or not port:
        return
    try:
        port_n = int(port)
    except (TypeError, ValueError):
        return
    payload = {**payload, "tab_id": tab_id, "tool": "hermes"}
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(1.0)
        s.connect(("127.0.0.1", port_n))
        s.sendall((json.dumps(payload) + "\n").encode("utf-8"))
        try:
            s.recv(256)
        except Exception:
            pass
        s.close()
    except Exception:
        pass


def _session_token(kwargs: dict):
    """Best-effort extraction of the Hermes session token from hook kwargs.

    The key name isn't documented; probe the likely shapes and only
    return when we actually find something. Coffee CLI uses it to read
    the session back from state.db for the copy-last-response feature.
    """
    for key in ("session_id", "session_token", "token", "session"):
        v = kwargs.get(key)
        if isinstance(v, str) and v:
            return v
        if v is not None and hasattr(v, "id"):
            return str(v.id)
    return None


def _on_session_start(**kwargs):
    payload = {"status": "idle", "event": "on_session_start", "cwd": os.getcwd()}
    token = _session_token(kwargs)
    if token:
        payload["session_id"] = token
    _post(payload)


def _pre_llm_call(**kwargs):
    _post({"status": "working", "event": "pre_llm_call"})


def _post_llm_call(**kwargs):
    _post({"status": "idle", "event": "post_llm_call"})


def _pre_tool_call(**kwargs):
    _post({"status": "working", "event": "pre_tool_call"})


def _pre_approval_request(**kwargs):
    _post({"status": "wait_input", "event": "pre_approval_request"})


def _post_approval_response(**kwargs):
    _post({"status": "working", "event": "post_approval_response"})


def _on_session_end(**kwargs):
    _post({"status": "idle", "event": "on_session_end"})


def register(ctx):
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("pre_llm_call", _pre_llm_call)
    ctx.register_hook("post_llm_call", _post_llm_call)
    ctx.register_hook("pre_tool_call", _pre_tool_call)
    ctx.register_hook("pre_approval_request", _pre_approval_request)
    ctx.register_hook("post_approval_response", _post_approval_response)
    ctx.register_hook("on_session_end", _on_session_end)
