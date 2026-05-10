// Coffee CLI — OpenCode Plugin
//
// Auto-loaded by OpenCode from ~/.config/opencode/plugins/ on every session.
// Subscribes to OpenCode's bus events via the catch-all `event` hook and
// forwards a normalized 3-state payload to the Coffee CLI hook server over
// loopback TCP — same protocol the Claude/Codex forwarders speak.
//
// Event-to-state mapping (verified against
// packages/opencode/src/session/status.ts and
// packages/sdk/js/src/gen/types.gen.ts on the dev branch):
//
//   working    — session.status with status.type === "busy" | "retry"
//                permission.replied   (user just answered, agent resumes)
//   wait_input — permission.updated   (a permission record exists awaiting
//                                      response — Permission has no status
//                                      field, so the event itself signals it)
//   idle       — session.idle / session.error
//                session.status with status.type === "idle"
//
// What is NOT mapped (intentionally):
//   message.updated / message.part.updated  — too noisy, fires per chunk
//   during streaming AND after stream ends (cleanup writes), which trapped
//   the dot in "working" for ~30s past actual idle (auto-idle fallback).
//   Working is already covered by session.status=busy; we don't need a
//   second source.
//
//   tool.execute.before / tool.execute.after — these are NAMED hooks in the
//   plugin Hooks interface, not bus events; the catch-all `event` handler
//   never receives them.
//
// Env vars (injected by Coffee CLI when spawning opencode):
//   COFFEE_CLI_TAB_ID, COFFEE_CLI_HOOK_PORT, COFFEE_CLI_TOOL=opencode
// Plugin auto-loads for ALL OpenCode sessions, including those started
// outside Coffee CLI — must no-op silently when env vars are missing.

import net from "node:net";

const COFFEE_DEBUG = process.env.COFFEE_CLI_DEBUG === "1";

function debug(...args) {
  if (COFFEE_DEBUG) {
    try { process.stderr.write(`[coffee-cli-island] ${args.join(" ")}\n`); } catch (_) {}
  }
}

function send(payload) {
  const tab_id = process.env.COFFEE_CLI_TAB_ID;
  const port = process.env.COFFEE_CLI_HOOK_PORT;
  const tool = process.env.COFFEE_CLI_TOOL || "";
  if (!tab_id || !port || tool !== "opencode") return;

  try {
    const s = net.createConnection({ host: "127.0.0.1", port: parseInt(port, 10) });
    s.setTimeout(800);
    const cleanup = () => { try { s.destroy(); } catch (_) {} };
    s.on("error", (err) => { debug("send err", err && err.message); cleanup(); });
    s.on("timeout", () => { debug("send timeout"); cleanup(); });
    s.on("connect", () => {
      const body = JSON.stringify({ tab_id, tool, ...payload }) + "\n";
      s.write(body);
      // Server acks with `{}\n` then closes. Give it 150ms to round-trip.
      setTimeout(cleanup, 150);
    });
  } catch (err) {
    debug("send caught", err && err.message);
  }
}

function mapEvent(evt) {
  if (!evt || typeof evt !== "object") return null;
  const type = evt.type || "";
  const props = evt.properties || {};

  switch (type) {
    case "session.idle":
    case "session.error":
      return { status: "idle", event: type };

    case "session.status": {
      // properties.status is a SessionStatus object: {type: "idle"|"retry"|"busy", ...}.
      // Old version of this plugin compared the whole object to "busy" — never
      // matched, which is why idle was missed.
      const inner = props.status || {};
      const t = inner.type;
      if (t === "busy" || t === "retry") return { status: "working", event: type };
      if (t === "idle") return { status: "idle", event: type };
      return null;
    }

    case "permission.updated":
      // Permission record was created or changed. Easiest 3-state read: any
      // permission.updated means the agent is blocked waiting for the user.
      // (permission.replied below transitions us back out.)
      return { status: "wait_input", event: type };

    case "permission.replied":
      // User answered — back to working until the next status flip.
      return { status: "working", event: type };

    default:
      return null;
  }
}

// File-touching tool names → Coffee CLI audit action label. OpenCode's
// tool.execute.after named hook fires after the tool runs, with the
// resolved input (including the file path argument).
const FILE_TOOL_ACTION = {
  edit: "edit",
  write: "create",
  patch: "edit",
};

function extractFilePath(input) {
  if (!input || typeof input !== "object") return null;
  // OpenCode tools settled on `filePath` (camelCase) for new tools and
  // `path` for older ones; accept either.
  return input.filePath || input.path || null;
}

// OpenCode loader (packages/opencode/src/plugin/index.ts) iterates Object.values
// of the loaded module and treats every function as a Plugin in legacy mode.
// We export a single named Plugin function; default-export is the same
// reference and is deduped by the loader's identity Set.
export const CoffeeCliIslandPlugin = async () => {
  debug("plugin loaded; tab=", process.env.COFFEE_CLI_TAB_ID || "<unset>",
        "port=", process.env.COFFEE_CLI_HOOK_PORT || "<unset>");
  return {
    // Bus events → 3-state status indicator
    event: async ({ event }) => {
      const mapped = mapEvent(event);
      if (mapped) {
        debug("→", event && event.type, "=>", mapped.status);
        send(mapped);
      }
    },
    // Named hook: feeds the file-edit audit log. Coffee CLI's Rust
    // side will compute the diff stats against the global baseline
    // and emit `tool-file-edit` to the frontend.
    "tool.execute.after": async ({ tool, input }) => {
      const action = FILE_TOOL_ACTION[tool];
      if (!action) return;
      const filePath = extractFilePath(input);
      if (!filePath) return;
      debug("file edit:", tool, action, filePath);
      send({ path: filePath, action });
    },
  };
};

export default CoffeeCliIslandPlugin;
