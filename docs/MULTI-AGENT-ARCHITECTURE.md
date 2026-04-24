# 可视化多智能体编排

> **Coffee-CLI 是目前唯一做「可视化」多智能体编排的桌面应用。**
>
> 4 个 AI CLI 并排跑，通过 MCP 工具互相派发任务，整个过程在你眼前发生，你可以随时接管。

---

## 一、我们的差异化——可视化

市面上做多 Agent 编排的项目不少，但**没有一个是可视化的**：

| 竞品 | 多 Agent 能力 | 可视化？ | 用户能接管？ |
|---|---|---|---|
| LangGraph / Mastra | ✅ 代码编排 | ❌ 要看日志 | 改代码 |
| Claude Agent Teams | ✅ 内部 subagent | ❌ 黑盒 | 不能 |
| Opcode / Warp / Superset | ✅ | ❌ | 看最终结果 |
| claude-squad / conductor-mcp | ✅（tmux） | ⚠️ tmux 窗口 | Windows 不能用 |
| **Coffee-CLI** | ✅ | ✅ **4 个 pane 并排窗口** | ✅ **任何时刻 Ctrl+C 或键入接管** |

"**可视化**"不是 UI 说辞，是**架构选择**：
- 每个 agent 在自己的 PTY pane 里跑，输出实时流式显示
- agent 之间的 MCP tool 调用，用户在 UI 里能看到浮现
- agent 互相派发的任务和回执（哨兵 DONE），全部在各自 scrollback 可读
- 用户随时点任意 pane 手动输入，打断 agent 任意一步

没有"后台黑盒执行"。**看得见 + 接得住**，这是 Coffee-CLI 唯一真正独占的护城河。

---

## 二、产品能力（什么可以做、什么不做）

### 可以做

- 4 个异构 AI CLI 同时运行（Claude / Codex / Gemini / OpenCode / OpenClaw / Qwen / Hermes 任意组合）
- Agent 之间通过 MCP 自主派发、查状态、读输出
- 任务完成时通过哨兵标记自动通知发起方（异步唤醒，无需轮询）
- 用户任何时刻点任意 pane 接管、中断、或换一个 CLI 重启该 pane
- 独立 2/3/4-split 模式：各 pane 互不干涉，只是视觉合并

### 不做

- ❌ DAG 可视化编辑器（那是 LangGraph / Mastra 的赛道）
- ❌ 任务持久化（内存 map 够用）
- ❌ 集群 / 远程 pane（所有 pane 都在本地）
- ❌ 跨 pane 自动上下文共享（agent 要的上下文自己通过 MCP 读）
- ❌ 全自动化，用户零介入（定位是"可见可接管"不是"完全托管"）

---

## 三、技术架构：MCP + 哨兵双层

**两层协议，职责不重叠**：

### Layer 1 — MCP（forward 派发）

3 个工具，标准 JSON-RPC，HTTP Streamable 传输：

- **`list_panes()`** —— 返回当前 Tab 所有 pane 的 `{pane_idx, cli, state, id, title}`。state 值：`empty` / `idle` / `busy` / `terminated`。
- **`send_to_pane(id, text, wait?, timeout_sec?)`** —— 派发任务给指定 pane。`wait=true` 阻塞等结果，`wait=false` 立即返回给调用者。空 pane / 不存在的 pane 返回结构化 error，**不会静默丢失**。
- **`read_pane(id, last_n_lines?)`** —— 读 target pane 的最近 N 行（ANSI 剥离）。

### Layer 2 — 哨兵协议（backward 回执）

Agent 干完任务后在自己 PTY 输出里打印：

```
[COFFEE-DONE:paneN->paneM]
```

Coffee-CLI 前端每帧扫描 PTY 输出：
1. 命中 marker 且 emitter pane 开启了 sentinel → 徽章亮绿点
2. + target pane M 也开启 sentinel → 注入 "`[From pane N] Task complete.`" + 自动回车到 pane M 的输入
3. pane M 的 LLM turn loop 被唤醒，继续编排

哨兵开关**每 pane 独立 opt-in**（点 pane 徽章上的小开关）。

### 两层一起的好处

- **MCP 给结构化能力**：发现邻居、得到失败反馈、结构化参数
- **哨兵给异步唤醒**：dispatcher 不用阻塞等或轮询
- **两层都天然可见**：MCP 调用 UI 能浮现，哨兵 marker 在 scrollback

---

## 四、关键实现文件

| 功能 | 文件 |
|---|---|
| MCP server（3 工具 + rmcp + axum） | [src/mcp_server.rs](../src/mcp_server.rs) |
| MCP 配置注入（`~/.claude.json` 等） | [src/mcp_injector.rs](../src/mcp_injector.rs) |
| 协议 `.md` 模板（CLAUDE.md / AGENTS.md / GEMINI.md） | [src/multi_agent_protocol.rs](../src/multi_agent_protocol.rs) |
| 哨兵 DONE 扫描器（前端） | [src-ui/src/components/center/TierTerminal.tsx](../src-ui/src/components/center/TierTerminal.tsx) |
| 多 Agent 布局 UI | [src-ui/src/components/center/MultiAgentGrid.tsx](../src-ui/src/components/center/MultiAgentGrid.tsx) |
| 独立 split 布局 UI | [src-ui/src/components/center/FourSplitGrid.tsx](../src-ui/src/components/center/FourSplitGrid.tsx) |

### 3 家 CLI 的 MCP 配置位置

| CLI | 配置文件 | 键 | 协议 .md |
|---|---|---|---|
| Claude Code | `~/.claude.json` | `mcpServers.coffee-cli` | `CLAUDE.md` |
| Codex CLI | `~/.codex/config.toml` | `[mcp_servers.coffee-cli]` | `AGENTS.md` |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers.coffee-cli` | `GEMINI.md` |

### MCP 配置清理的三重保障

防止"单开 Claude 窗口见 1 MCP server failed"的关键——三路清理，任何一路跑到就干净：

1. 用户**关闭多 Agent 模式** → `disable_multi_agent_mode` 调 `uninstall_all`
2. Coffee-CLI **进程退出** → Tauri shutdown hook 调 `uninstall_all`
3. Coffee-CLI **下次启动** → `start_ui` self-heal 调 `uninstall_all` 兜底

---

## 五、决策记录（精简版）

### 2026-04-22 — MCP + 哨兵双层方案定稿
3 个 MCP 工具 + 哨兵 DONE 回执。HTTP 传输（不走 stdio，因 Coffee-CLI 是常驻进程）。主控 CLI 锁定 3 家：Claude Code / Codex / Gemini（OpenCode config 形状差异大，v1.1 单独做）。

### 2026-04-24 — ⚠️ 错误方向
误判"MCP 残留端口报错"为"MCP 架构缺陷"，退 MCP 改走纯 PTY-marker。同时把"哨兵 = MCP 之上的 receipt 层"误解成"哨兵 = 替代 MCP 的协议"。写了错误版架构文档。

### 2026-04-25 — ✅ 纠正
用户指出"1 号派给空的 2 号 = 指挥空气"——纯 PTY-marker 没有发现 / 无失败反馈 / 要 hack ANSI+chunk+pane-号注入。恢复 MCP，保留哨兵 DONE 做 receipt 层。强化三路清理杜绝端口残留 bug。**这才是 2026-04-22 原本就该做对的事**。

### v1.3.0（2026-04-25）发布
MCP + 哨兵双层完整落地。

---

## 六、不变量（永远不破）

1. **可视化**是产品灵魂——任何"后台黑盒执行"的提议都不做
2. **用户能随时接管**——Ctrl+C / 点 pane / 关 pane / 换 CLI 全部任意时刻可操作
3. **agent 间通信走业界标准 MCP**，不自造私有结构化协议
4. **MCP 注入的 3 家 config 必须精确回收**（三路保底）
5. **协议 `.md` 不能对 agent 撒谎**——教给 agent 的工具必须真实可调
6. **Windows 优先**——任何只能 POSIX 跑的方案直接否决

---

## 七、独立 split 模式（和多 Agent 完全不同）

Coffee-CLI 还有独立 2/3/4-split 布局，session_id 用 `::split-N` 前缀（vs 多 Agent 的 `::pane-N`）：

| 模式 | MCP 注入 | Agent 互相看见 | 用途 |
|---|---|---|---|
| 多 Agent 2/3/4 | ✅ | ✅ | 协作 |
| 独立 split 2/3/4 | ❌ | ❌ | 纯视觉合并，各跑各的 |

两种模式代码路径完全分离，用户在 UI 上分别入口进入。

---

## 八、风险清单

| 风险 | 对策 |
|---|---|
| MCP 端口残留报错 | 三路清理到位（disable + shutdown + start_ui self-heal） |
| PTY backpressure 4 路并发 | 每 pane 独立 channel；stress test 必过 |
| rmcp crate API 变动 | 锁定版本，升级前小规模测 |
| xterm.js 4 实例内存 | 非活跃 Tab 暂停渲染 |
| LLM 不会用 MCP 工具 | 协议 `.md` 明确教，UI 可加示例 prompt 引导 |
| 非 Windows 平台测试覆盖不足 | CI 编译四端但未自动化 runtime smoke test（后续迭代） |
