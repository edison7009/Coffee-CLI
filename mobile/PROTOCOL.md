# Coffee CLI 移动端协议草案（v0）

状态：草案，未实现。范围：手机作为**遥控器**——看会话、看输出、发输入、处理审批、收状态推送。手机不跑工具、不改配置、不浏览/修改文件系统。

---

## 1. 拓扑

```
手机 App ──WSS──▶ coffee-relay（CF Worker + Durable Object）◀──WSS(桌面主动)── Coffee CLI 桌面
手机 App ──WS(局域网，同一套帧)────────────────────────────────▶ Coffee CLI 桌面 mobile_rpc 监听
```

- 局域网直连和中继走**同一套应用层帧**；区别只在传输层。中继只转发不透明密文。
- 桌面端新模块 `src/mobile_rpc/`：一个 WebSocket 监听（默认关闭，设置里开启；默认只绑定局域网地址，端口待定）+ 一个可选的中继出站连接。
- 协议实现**复用现有内部函数**，不复用 Tauri IPC 本身（`tier_terminal_input` 等是 `#[tauri::command]`，需把核心逻辑抽成普通函数供两边调用）。

## 2. 配对与认证

1. 桌面「设置 → 移动端」生成二维码：`coffee://pair?v=0&host=<lan>:<port>&relay=<url>&pid=<pairingId>&pk=<desktopPubKey>&otp=<一次性码>`，有效期 5 分钟。
2. 手机生成 X25519 密钥对，扫码后发 `pair.request {devicePubKey, deviceName, otp}`（用桌面公钥加密）。
3. 桌面**弹窗确认**（显示设备名），确认后把设备公钥写入 `~/.coffee-cli/mobile/devices.json`（只存公钥，不存密钥）。
4. 之后每次连接：Noise `IK` 握手（或 X25519 + HKDF + ChaCha20-Poly1305 的等价实现）→ 会话密钥。握手失败直接断开，不回错误详情。
5. 桌面可在设置里吊销设备；吊销后立即断开该设备所有连接。

中继侧只认 `pairingId`（随机 128 bit）做路由，看不到密钥和一次性码。

## 3. 帧格式

握手后每条 WebSocket 消息 = 一个加密 JSON 对象（局域网也加密，不区分）。明文结构参考 JSON-RPC 2.0，去掉 `jsonrpc` 字段：

```jsonc
// 请求
{ "id": 12, "method": "session.list", "params": {} }
// 响应
{ "id": 12, "result": { ... } }
{ "id": 12, "error": { "code": "not_found", "message": "..." } }
// 事件（桌面 → 手机，无 id）
{ "event": "terminal.output", "params": { ... }, "seq": 8812 }
```

- `seq`：每个连接上事件单调递增，用于断线重连后检测丢失。
- 错误码用字符串枚举：`unauthorized` `not_found` `invalid_params` `busy` `unsupported` `internal`。
- 版本协商：连接后第一条必须是 `hello`。

## 4. 方法

### 4.1 连接

| 方法 | params | result |
|---|---|---|
| `hello` | `{protocol: 0, appVersion, platform: "ios"\|"android", locale}` | `{protocol: 0, desktopVersion, computerName, capabilities: string[]}` |
| `ping` | `{}` | `{t}` |

`protocol` 不一致时桌面返回 `unsupported` 并附带 `minProtocol`，手机提示升级。`capabilities` 用来做向前兼容的功能开关（如 `"approvals"`、`"voice"`）。

### 4.2 会话

| 方法 | params | result |
|---|---|---|
| `session.list` | `{}` | `{sessions: Session[]}` |
| `session.subscribe` | `{id, cols, rows, replayBytes?}` | `{snapshot: string, seq}` |
| `session.unsubscribe` | `{id}` | `{}` |
| `session.input` | `{id, data}` | `{}` |
| `session.interrupt` | `{id}` | `{}`（等价发送 `\x03`，单独列出便于手机做按钮） |

```ts
type Session = {
  id: string;            // 与桌面 tier-terminal session_id 相同
  tool: string;          // "claude" | "codex" | "opencode" | "shell" | ...
  title: string;         // 当前 OSC 标题（与桌面 tab 一致）
  cwd: string;
  status: "idle" | "working" | "waiting" | "exited";  // 对应灵动岛三色
  exitCode?: number;
  updatedAt: number;     // ms
};
```

**尺寸**：手机订阅时**不 resize 桌面 PTY**（会搞乱桌面端 TUI）。`cols/rows` 只用于桌面端决定 `snapshot` 的格式；手机端 xterm 按桌面实际尺寸渲染、缩放显示。是否允许手机“接管尺寸”留到 v1 讨论。

**snapshot**：桌面维护每个会话的 headless 终端状态（或最近 N KB 原始输出环形缓冲，v0 先用后者，默认 256 KB），订阅时一次性发出，然后接增量。

### 4.3 结构化对话（核心卖点）

竞品手机端基本只能看终端字符流。Coffee CLI 桌面端已经为六种会话做了结构化对话视图：`claude-session-event`、`codex-session-event`、`opencode-session-event`、`pi-session-event`、`dsh-session-event`，以及自研 agent 的 `agent-conversations-changed`。前端对应的 reducer 在 `src-ui/src/lib/*-session.ts`。手机端**直接复用这些事件和 reducer**，展示消息气泡、工具调用卡片、diff、思考过程、用量，而不是一屏 ANSI 字符。

| 方法 | params | result |
|---|---|---|
| `conversation.subscribe` | `{id, history?: number}` | `{state: ConversationState, seq}` |
| `conversation.unsubscribe` | `{id}` | `{}` |
| `conversation.send` | `{id, text, attachments?: []}` | `{}`（走桌面端同一条发送路径，不是向 PTY 写字符） |
| `conversation.cancel` | `{id}` | `{}` |

- `ConversationState` 就是桌面 reducer 的输出，形状由共享 TS 类型决定，用一个 `kind` 区分来源：`"claude" | "codex" | "opencode" | "pi" | "dsh" | "agent"`。
- 增量更新原样转发原始事件：`{"event":"conversation.event","params":{id, kind, payload}}`。手机端跑同一个 reducer，保证两端看到的状态一致。
- 为此要把 `src-ui/src/lib/*-session.ts` 里的纯 reducer 拆到 `src-ui/src/shared/conversation/` 中，不能依赖 DOM 或 Tauri，让 RN 也能 import。这是阶段 1 的主要重构工作。
- `Session` 增加字段 `view: "conversation" | "terminal"`。结构化会话默认打开对话视图，终端视图作为备用；普通 shell 和 T2 工具只有终端视图。
- 在手机上，长内容（大 diff、长工具输出）默认折叠，点开时按需请求：`conversation.expand {id, itemId}` → `{content}`，避免首屏传输过大。

### 4.4 审批

| 方法 | params | result |
|---|---|---|
| `approval.list` | `{}` | `{items: Approval[]}` |
| `approval.respond` | `{id, decision: "allow" \| "deny", remember?: false}` | `{}` |

```ts
type Approval = {
  id: string; sessionId: string; tool: string;
  kind: "command" | "edit" | "other";
  summary: string;       // 已截断的展示文本
  createdAt: number;
};
```

来源复用 `agent_approvals.rs` 与各工具 hook（Claude 真岛）。不支持结构化审批的工具不出现在这里，手机只能在终端里直接输入回应。

## 5. 事件

| 事件 | params | 来源（现有） |
|---|---|---|
| `session.changed` | `Session` | `tier-terminal-status` / `tier-terminal-cwd` / 标题变化 / 灵动岛状态 |
| `session.removed` | `{id}` | `tier-terminal-exit` 后清理 |
| `terminal.output` | `{id, data}` | `tier-terminal-output`（已做 8ms 合并） |
| `conversation.event` | `{id, kind, payload}` | 六种 `*-session-event` / `agent-conversations-changed` |
| `approval.created` | `Approval` | approvals / hooks |
| `approval.resolved` | `{id, decision, by: "desktop" \| "mobile"}` | 任一端处理后 |

只向已 `session.subscribe` 的会话推 `terminal.output`；其它事件对所有已认证连接广播。

## 6. 背压与重连

- 桌面每个连接一个有界发送队列（例如 2 MB）。超出时**丢弃该会话的增量输出**，改发 `{"event":"terminal.resync","params":{"id"}}`，手机重新 `session.subscribe` 拿 snapshot。绝不阻塞 PTY reader 线程（见 AGENTS.md 中 PTY 根因 #2）。
- 手机断线重连：重新握手 → `hello` → 对之前订阅的会话重新 `subscribe`。v0 不做按 `seq` 补发。
- 心跳：手机每 20 s `ping`，45 s 没收到响应就判定断线。中继连接由桌面每 30 s 发送 WebSocket ping 保活。

## 7. 推送（阶段 4，占位）

桌面检测到 `status → waiting`、`approval.created` 或“工作中 → 空闲”（任务完成）时，经中继发 `push.notify {deviceTokenRef, title, body, sessionId}`。推送内容**在桌面加密**，中继只看到通知类别；手机用 Notification Service Extension（iOS）或数据消息（Android）在本地解密后展示。

## 8. 中继协议（coffee-relay 仓库，摘要）

- `GET /v0/desktop?pid=…`：桌面出站 WSS，每个 `pid` 一个 Durable Object。
- `GET /v0/mobile?pid=…`：手机 WSS；DO 把两端帧原样桥接，同一个 `pid` 可连多部手机。
- 中继不解析载荷，不落盘；有速率限制和单帧大小上限（1 MB）。

## 9. 安全边界

- 白名单方法之外一律 `unsupported`。v0 **不暴露**：文件读写（`fs_*`、`read_text_file`）、密码（`load_password`）、工具配置写入、自更新、`open_url`、剪贴板。
- `session.input` 能执行任意命令，这一点等同于远程 shell，必须在 UI 里讲清楚；开启移动端时在设置里明确提示。
- 桌面端在每条请求上校验设备仍未被吊销。

## 10. 测试计划

- `src/mobile_rpc/` 单元测试：帧编解码、握手、方法白名单、背压时触发 resync，接入 `cargo test`。
- `src-ui/src/shared/mobile-protocol.ts`：TS 类型 + 契约测试（与 Rust 端共享 JSON 样本 `docs/mobile/fixtures/*.json`），接入 `npm test`。
- 原生协议测试：扩展 `npm run test:native`，用模拟手机客户端连接本地 `mobile_rpc`，不启动真实工具。

## 11. 待决问题

1. 手机端是否允许 resize / 接管尺寸？
2. 环形缓冲还是 headless xterm 做 snapshot？（后者回放更准，但多一份 VT 解析成本）
3. 是否允许手机端新建会话（`session.start {tool, cwd}`）？ v0 倾向不允许。
4. 移动端功能是否放进 VIP（`feat/account`）？
5. 加密实现：`snow`（Noise）还是自写 X25519+AEAD？

---

## 12. 产品目标与界面原则

- **核心差异**：竞品手机端基本只显示终端字符流；我们把桌面端六种结构化对话（Claude、Codex、OpenCode、Pi、DeepSeek Harness、自研 agent）完整搬到手机上：消息气泡、工具调用卡片、diff、思考过程、用量、审批。
- **界面要求**：原生质感优先，不能做成网页套壳。对话列表、气泡、工具卡片都用原生组件；终端视图只作为兜底，可以用 WebView + xterm。
- **范围**：v0 只支持上面六种结构化会话，其他工具以后再说。

## 13. 中继与商业分层

协议和中继开源，用户可以自己部署；官方中继作为付费服务（挂在 `feat/account` 的 VIP 体系上）。

| 能力 | 免费 | VIP |
|---|---|---|
| 局域网直连 | ✅ | ✅ |
| 自建中继（Cloudflare / Docker） | ✅ | ✅ |
| 官方中继节点 | 试用 | ✅ |
| 后台推送（任务完成 / 等待确认） | ❌ | ✅ |
| 国内加速节点 | ❌ | ✅ |

- 推送依赖我们自己 App 的 APNs/FCM 密钥，自建中继天然发不了推送，这就是官方服务的价值所在；推送以外的功能自建版一样不少。
- 官方中继同样端到端加密，只能看到密文。VIP 校验放在中继建立连接的阶段（账号签发的短期令牌），不碰载荷内容。

## 14. 开发节奏

- 分支 `feat/mobile` 长期开发，不合入 `main`，不影响桌面端迭代；定期 rebase 到 `main`。
- 阶段顺序：协议定稿 → 拆共享 reducer（`src-ui/src/shared/conversation/`）→ 桌面 `mobile_rpc`（默认关闭）→ `mobile/` 局域网版 → `coffee-relay` 仓库 → 推送与上架。
- 苹果开发者账号到位之前，iOS 只在模拟器和本机调试；Android 可以先出测试包。
