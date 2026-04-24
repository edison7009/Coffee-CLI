# Coffee-CLI 多 Agent 协作架构设计

> 本文档是"北极星文档"——任何 session 讨论多 Agent 功能时，先读本文档再开工。
>
> 初稿：2026-04-22（MCP 方案定稿）
> 2026-04-24：错误推论——把"MCP 残留端口 bug"扩大成"退 MCP"，写了错误版本的北极星
> **2026-04-25 纠正并重写为最终版：MCP + Sentinel 双层协议**
>
> 状态：**MCP（forward 派发）+ 哨兵协议（backward 回执）双层架构**，本文为正确版

---

## 一、文档目的

定义 Coffee-CLI 多 Agent 协作功能的：
- 产品定位（永不偏移的北极星）
- 技术路线（做什么 + **不做什么**）
- 范围边界
- 当前真实实现

本文档存在的原因：**防止多轮 AI 对话中目标漂移**。任何改动产品方向的提议，需先改本文档。

---

## 二、产品定位（北极星）

> **Coffee-CLI 是"跨 CLI 进程的可视化协作容器"**
>
> 4 个 AI CLI 并排跑，**agent 之间通过 MCP 工具自主调度**，完成后**通过哨兵标记自动回执**，**全程在用户眼前发生可随时接管**。

核心卖点一句话：

> **"Claude Code 可以自动让 Codex 和 Gemini 干活，你在一个窗口里看 4 个 agent 相互协作，随时能干预。"**

市场独特性（竞品做不到）：
- Opcode / Warp / Superset：有多 Agent，但**用户看不到被控过程**
- LangGraph / Mastra：**要写 DAG 代码**，学习成本高
- Claude subagent：**过程对用户黑盒**
- claude-squad / conductor-mcp：**Windows 不能用**（依赖 tmux）

**Coffee-CLI 独占位**：Windows 原生 + 用户可见 + 用户可干预 + 异构 CLI 组合 + agent 自主协作。

---

## 三、核心设计哲学：MCP 做工具，哨兵做提示

**双层协议**，职责不重叠：

**Layer 1 — MCP（forward：主动派发）**
  - 结构化 JSON-RPC over HTTP（Streamable）
  - 3 个工具：`list_panes()` / `send_to_pane()` / `read_pane()`
  - Agent 主动调工具 → 得到结构化返回值 / 错误
  - 业界标准，Claude Code / Codex / Gemini 原生支持

**Layer 2 — 哨兵协议（backward：完成回执）**
  - PTY 文本标记 `[COFFEE-DONE:paneN->paneM]`
  - Agent 干完活后在自己输出里打印一行
  - Coffee-CLI 前端扫到 → 自动把 "Task complete" 注入发起方的输入框 + 回车
  - 每 pane 独立 opt-in（UI 上有 sentinel 开关）

**为什么不能只用一层**：
- 只用 MCP：agent 派完活要轮询 `read_pane` 或用户手动检查 → 费上下文 + 费眼睛
- 只用哨兵：没有 `list_panes` 发现邻居、没有失败反馈、要 agent 把长任务摘要到单行 → 残废版 MCP

**两层一起才是完整**：MCP 负责把活送出去，哨兵负责把"干完了"送回来。

---

## 四、被否决的方向（永不要再提，除非推翻本文档）

| 方向 | 否决理由 |
|---|---|
| **只用 PTY marker（2026-04-24 错误路线）** | 丢失 MCP 的 list_panes / 失败反馈 / 结构化 / wait 语义，要 hack 一堆 ANSI+chunk+prompt 注入去补丁——等于重新发明次优 MCP |
| **DAG 编排层**（mailbox / signal / wait_for_channel） | 滑向 Mastra/LangGraph，和巨头正面竞争 |
| **Agent 身份识别协议 / sender tag** | `list_panes()` 返回值 + `[From pane N]` 前缀已够 |
| **Safety tier 三档** | 3 个工具不值得分层 |
| **Workstation 模式** | 已砍，tag `archive/workstation-mode` |
| **容器化隔离 / git worktree** | 定位是"可视化容器"不是"隔离沙箱" |
| **Agent 心跳 / heartbeat** | 不做进程健康监控，PTY 挂了用户重启 |
| **DetachedTerminal（tab 分离窗口）** | 2026-04-24 删除，零引用 |
| **Pane 布局 DSL** | 固定四宫格 + 1×2 / 1×3 够了 |

---

## 五、技术架构

### 5.1 系统总览

```
┌─ Coffee-CLI (Tauri v2 + Rust + xterm.js) ──────────────────────────┐
│                                                                    │
│  ┌─ Pane Grid（UI 层）──────────────────────────────┐             │
│  │  2×2 / 1×2 / 1×3 多种布局                          │             │
│  │  每格独立 portable-pty 子进程，运行任意 CLI         │             │
│  └────────────────────────────────────────────────────┘             │
│                        ↕                                            │
│  ┌─ Coffee-CLI MCP Server（Rust, rmcp）────────────┐               │
│  │  HTTP Streamable at 127.0.0.1:<dynamic>/mcp      │               │
│  │  3 tools: list_panes / send_to_pane / read_pane  │               │
│  │  PaneStore 桥接 terminal::SharedSession          │               │
│  └────────────────────────────────────────────────────┘             │
│                        ↑                                            │
│  ┌─ Sentinel Scanner（前端 TierTerminal.tsx）─────┐                │
│  │  扫每帧 PTY 输出 regex [COFFEE-DONE:paneN->paneM]│                │
│  │  命中且双方 sentinel 开启 → 注入 "Task complete" │                │
│  │  到 paneM 的输入 + 自动回车                       │                │
│  └────────────────────────────────────────────────────┘                │
│                                                                    │
│  ┌─ 配置注入（每个 CLI 都得改自己的 config）────────┐               │
│  │  ~/.claude.json       ← mcpServers.coffee-cli     │               │
│  │  ~/.codex/config.toml ← [mcp_servers.coffee-cli]  │               │
│  │  ~/.gemini/settings.json ← mcpServers.coffee-cli  │               │
│  │  CLAUDE.md / AGENTS.md / GEMINI.md ← 协议说明      │               │
│  └────────────────────────────────────────────────────┘                │
└────────────────────────────────────────────────────────────────────┘
```

### 5.2 MCP 工具 API（3 个，就这么多）

**`list_panes()`** — 无参数
```json
[{
  "id": "tab-abc::pane-1",
  "pane_idx": 1,
  "cli": "claude" | "gemini" | "codex" | "opencode" | null,
  "state": "idle" | "busy" | "empty" | "terminated",
  "title": "E:\\test",
  "last_activity_at": "2026-04-25T..."
}]
```

**`send_to_pane(id, text, wait=true, timeout_sec=600)`**
- `wait=true`：阻塞直到 target 返回 idle（或超时），返回 `{status:"completed", output:"<captured>"}`
- `wait=false`：立即返回 `{status:"submitted"}`，后续用 `read_pane` 查
- 超时：`{status:"timeout"}`，**任务可能还在跑**，不等于失败
- 错误：empty pane / self-dispatch / terminated → 结构化 error

**`read_pane(id, last_n_lines=200)`**
- 返回 `{output:"<ANSI-stripped>", is_idle:bool, cursor_prompt:"<current prompt line>"}`

**不加第 4 个工具**。新需求必须先证明 3 个组合不够。

### 5.3 哨兵协议（完成回执）

**marker 格式**：
```
[COFFEE-DONE:paneN->paneM]
```
(N = 报告完成的 pane，M = 原本派活的 pane)

**前端行为**（见 [src-ui/src/components/center/TierTerminal.tsx](../src-ui/src/components/center/TierTerminal.tsx)）：
1. 每个 pane 的 PTY 输出流过 ANSI-strip 缓冲
2. regex 扫 `[COFFEE-DONE:pane(\d+)->pane(\d+)]`
3. 命中且 **emitter pane 开启 sentinel** → 徽章绿点 30 分钟
4. + **target pane 也开启 sentinel** → 向 target PTY 注入 "[From pane N] Task complete." + 自动回车
5. 否则 marker 静默躺在 emitter scrollback 里，不做任何事

**为什么两边都要 opt-in**：发起方是因为扫描器检测成本（虽然很低）；目标方是用户授权"可以被自动注入输入"。安全默认是关闭。

### 5.4 MCP 配置注入与清理（关键）

Coffee-CLI 启动时在 `127.0.0.1:<随机>/mcp` 跑 MCP server。要让 3 家 CLI 能连上，必须**把 coffee-cli 条目写进它们各自的全局配置**：

| CLI | 配置文件 | 键 |
|---|---|---|
| Claude Code | `~/.claude.json` | `mcpServers.coffee-cli` |
| Codex CLI | `~/.codex/config.toml` | `[mcp_servers.coffee-cli]` |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers.coffee-cli` |

注入逻辑：[src/mcp_injector.rs](../src/mcp_injector.rs)。**Merge 不 overwrite**，用户自己的 MCP 条目不动。

**清理时机**（这是 2026-04-24 踩坑的关键）：
1. **用户关闭多 Agent 模式**时（`disable_multi_agent_mode`）→ `uninstall_all`
2. **Coffee-CLI 关闭时**（Tauri shutdown hook）→ `uninstall_all`
3. **Coffee-CLI 启动时 self-heal**（`start_ui`）→ `uninstall_all` 清掉老版本残留

**不清理会发生什么**：MCP server 端口死了，用户打开**独立 Claude 窗口**（不在 Coffee-CLI 里），Claude 启动时读 `~/.claude.json`，尝试连死端口 → "1 MCP server failed"。2026-04-24 之前就是这个 bug 导致我误以为 MCP 架构有问题，其实只是清理没做干净。

### 5.5 协议 `.md` 注入

同时注入工作区根：
- `CLAUDE.md`（Claude Code 读）
- `AGENTS.md`（Codex、OpenCode 读）
- `GEMINI.md`（Gemini 读）
- `.multi-agent/PROTOCOL.md`（长文档，上面三者指向）

内容由 [src/multi_agent_protocol.rs](../src/multi_agent_protocol.rs) 模板生成，教 agent：
- 3 个 MCP 工具怎么用（dispatch + discover + read）
- DONE marker 什么时候发
- 跨 pane 通信用英文
- 派发模式：simple / fan-out / pipeline
- 什么时候**不要**派发（自己能做的、用户直接问的、intra-CLI 并行）

### 5.6 Tab 独立性

- 多 Agent 模式 = **每个 Tab 独立属性**
- 同一 Coffee-CLI 窗口可以 Tab1=单终端、Tab2=四宫格
- Tab 切换不影响其他 Tab 的 pane 或 MCP 连接
- 每个 pane 的 sentinel 开关独立

---

## 六、关键参考

| 参考 | 抄什么 | 规避什么 |
|---|---|---|
| [claude_code_bridge](https://github.com/bfly123/claude_code_bridge) | 三文件注入 CLAUDE.md / AGENTS.md / GEMINI.md | AF_UNIX + tmux 236 处硬编码 = Windows 死路 |
| [conductor-mcp](https://github.com/GGPrompts/conductor-mcp) | send_keys 的 800ms submit 延迟经验 | tmux 依赖 |
| [Superset](https://github.com/superset-sh/superset) | 500ms 轮询 + 参数化 timeout | Cloud API + DB 架构过重 |

---

## 七、范围边界

### 7.1 v1.2 已交付（回归 MCP + 哨兵双层）

- [x] 四宫格 + 1×2 / 1×3 布局
- [x] 每格独立 portable-pty 子进程
- [x] Tab 独立的多 Agent 模式开关
- [x] **MCP Server 启动时 spawn**，HTTP Streamable 127.0.0.1:随机 port
- [x] **3 MCP 工具**（list_panes / send_to_pane / read_pane）
- [x] **向 3 家 CLI 注入 mcpServers.coffee-cli**（启用时）+ **清理**（禁用/关闭/启动 self-heal 三路）
- [x] 协议 .md 注入（CLAUDE.md / AGENTS.md / GEMINI.md + `.multi-agent/PROTOCOL.md`）
- [x] **哨兵 DONE marker 扫描**（每 pane 独立 opt-in）
- [x] Gambit 用户手动广播
- [x] 7 家 built-in AI CLI（Claude / OpenCode / OpenClaw / Codex / Gemini / Qwen / Hermes）

### 7.2 永不做

- ❌ **纯 PTY-marker 替代 MCP**（2026-04-24 那次错误）
- ❌ DAG 编排 / Workflow engine
- ❌ git worktree / 容器化沙箱
- ❌ 任务持久化到磁盘
- ❌ 集群 / 远程 pane
- ❌ pane 之间自动上下文共享

### 7.3 未来可能考虑（不承诺）

- ACP adapter（结构化 diff/permission，供支持 ACP 的 CLI 并存使用）

---

## 八、风险清单

| 风险 | 对策 |
|---|---|
| **MCP 端口残留报错** | 3 路清理（disable/shutdown/start_ui self-heal）全部到位，踩过坑 |
| **PTY backpressure 4 路并发** | 每 pane 独立 channel；stress test 必须过 |
| **rmcp crate 不稳定 API 变动** | 锁定版本，升级前小规模测 |
| **xterm.js 4 实例内存** | 非活跃 Tab 暂停渲染 |
| **用户不知道何时开 sentinel** | UI 提示：sentinel 只影响完成通知；dispatch 永远通过 MCP 跑 |
| **LLM 不会用 MCP 工具** | 协议 .md 明确教，必要时 UI 加"推荐 prompt"示例卡片 |

---

## 九、决策日志

| 日期 | 决策 | 理由 |
|---|---|---|
| 2026-04-22 | 确定走"3 MCP 工具 + 四宫格 + 三文件注入"路线 | 方案对比后最优；详见附录 F |
| 2026-04-22 | 否决 DAG / mailbox / signal | 编排决策权归 agent，Coffee-CLI 只做通信原语 |
| 2026-04-23 | MCP 传输选 HTTP 不选 stdio | Coffee-CLI 常驻进程不能被 spawn |
| 2026-04-23 | 主控 CLI 锁定 3 家（Claude / Codex / Gemini） | OpenCode 的 config 形状差异太大 |
| **2026-04-24 ⚠️ 错误** | 退 MCP 全盘改走 PTY-marker | **错误推论**：把"老版本端口残留报错"放大成"MCP 架构有问题"。实际只是 shutdown 清理没做干净。同时混淆了用户设计的"哨兵协议 = MCP 之上的 receipt 层"和"哨兵 = 替代 MCP"——是 AI 的误读，不是用户要求 |
| 2026-04-24 | 删 DetachedTerminal + 翻译脚本 + OpenClaw 加入 built-in | 独立清理任务，不受 MCP 反悔影响 |
| **2026-04-25 ✅ 纠正** | **恢复 MCP，重写文档明确"MCP + 哨兵双层"** | 用户在 v1.2.0 测试时发现单 PTY-marker 路线无法发现邻居、无法反馈失败、chunk/ANSI/pane-号都要 hack 补丁。用户一句"指挥空气"戳穿问题。恢复 MCP 工作量 1-2 小时，代码归档还在，直接激活 |
| 2026-04-25 | **强化清理**：确保 `disable` + `shutdown` + `start_ui self-heal` 三路都清，单开 Claude 不再见 "1 MCP server failed" | 这才是 2026-04-22 原本就该做对的事 |

---

## 附录 A：不变量（永不违背）

1. **Coffee-CLI 永远是"可视化容器"不是"编排器"** —— 多步自动决策归 agent 自己 / 业界标准协议，不归 Coffee-CLI 写 DAG
2. **永远优先 Windows 用户** —— 任何只能在 POSIX 跑的方案直接否决
3. **agent 间通信走业界标准 MCP**，不自造私有结构化协议（PTY marker 只做完成提示这一件事）
4. **用户全程可见可干预** —— MCP tool call 在 UI 浮现、DONE marker 在 scrollback、injections 在 target scrollback，都可读
5. **MCP 注入的 3 家 config 必须精确回收** —— shutdown/disable/start_ui 三路保底
6. **协议 `.md` 不能对 agent 撒谎** —— 告诉 agent 的工具必须真实可调

---

## 附录 B：3 家 CLI MCP 配置接入清单

| CLI | mcp 配置文件 | 配置 key | 协议 .md |
|---|---|---|---|
| Claude Code | `~/.claude.json` | `mcpServers.coffee-cli` | `CLAUDE.md` |
| Codex CLI | `~/.codex/config.toml` | `[mcp_servers.coffee-cli]` | `AGENTS.md` |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers.coffee-cli` | `GEMINI.md` |

**传输**：全部 HTTP Streamable
```json
{
  "url": "http://127.0.0.1:<port>/mcp",
  "headers": { "X-Coffee-CLI-Port": "<port>" }
}
```
端口写入 `.multi-agent/endpoint.json` 便于用户/工具调试。

---

## 附录 E：竞品扫描与独占位（2026-04-22 扫描，结论仍成立）

| 方案 | 跨 CLI | Windows 原生 | GUI | 用户可见 | 对我们的影响 |
|---|---|---|---|---|---|
| metaswarm | 半真 | ❌ | ❌ | ❌ | 零威胁 |
| myclaude | 真（Go wrapper） | ⚠️ POSIX-first | ❌ | ❌ | 零威胁 |
| claude_code_bridge | 真（tmux） | ❌ | ❌ tmux pane | ✅ | 零威胁 |
| Claude Co-Commands | 插件 | — | ❌ | ❌ | 零威胁 |
| Zed ACP | 1:1 协议 | ✅ | Zed/JetBrains 内 | ✅ | 机会窗，v1.x+ 可选 adapter |

三条护城河完整：**桌面 GUI + 可见多 PTY / Windows 原生 / 异构 CLI 自主协作**。

---

## 附录 F：方案对比

2026-04-22 原始对比：

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| **A. MCP + 哨兵**（选定） | 标准协议、结构化、有失败反馈 + 轻量 opt-in 回执 | 要注入 3 家 config，需做好清理 | ✅ **选定** |
| B. 完整 DAG 编排器 | 强大 | 和 LangGraph / Mastra 正面打 | ❌ 打不过 |
| C. 纯 PTY-marker | 简单、零注入 | 无发现 / 无结构化 / 无失败反馈 | ❌ 残废 |

2026-04-24 我错误选了 C。2026-04-25 纠正为 A。

**历史教训**：当你在方案 A 上遇到一个具体 bug（如清理逻辑漏），**修 bug**，不要切到方案 C 再发现方案 C 缺一半功能再切回来。
