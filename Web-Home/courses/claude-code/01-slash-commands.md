<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../resources/logos/claude-howto-logo-dark.svg">
  <img alt="Claude How To" src="../resources/logos/claude-howto-logo.svg">
</picture>

# Slash Commands 指南

slash commands 是你在 Claude Code 里最容易立即上手的能力。它们本质上是“用 `/command` 快速触发某个操作或工作流”。

对新手来说，先学会 slash commands，通常比先碰 hooks、MCP 或 plugins 更有回报，因为：

- 安装简单
- 反馈快
- 更容易理解 Claude Code 的工作方式
- 很多常用工作流都能先用它起步

---

## 什么是 slash commands

Claude Code 里的 slash commands 大致分四类：

- **Built-in commands**：Claude Code 自带的命令，如 `/help`、`/clear`、`/model`
- **Skills 形式的命令**：通过 `SKILL.md` 定义，仍然可以用 `/name` 调用
- **Plugin commands**：安装 plugin 后带来的命令
- **MCP prompts**：由 MCP server 暴露出来的命令

> 现在更推荐用 `skills` 来承载自定义命令。`.claude/commands/` 依然能用，但新项目更建议看 [03-skills](../03-skills/)。

---

## 先知道这几个高频命令

| 命令 | 用途 |
|------|------|
| `/help` | 查看帮助和命令列表 |
| `/clear` | 清空当前会话 |
| `/config` | 查看或编辑设置 |
| `/context` | 看上下文使用情况 |
| `/model` | 切换模型 |
| `/effort [low|medium|high|xhigh|max|auto]` | 用交互滑杆调整思考强度；Opus 4.7 默认是 `xhigh` |
| `/agents` | 查看可用 agents |
| `/skills` | 查看可用 skills |
| `/hooks` | 查看 hooks |
| `/mcp` | 管理 MCP |
| `/plugin` | 管理 plugins |
| `/plan` | 进入 planning mode |
| `/focus` | 切换 focus view，减少长任务时的视觉干扰 |
| `/less-permission-prompts` | 分析常见 Bash / MCP 调用，帮你生成更合理的 allowlist |
| `/proactive` | `/loop` 的别名 |
| `/recap` | 回来继续 session 时，快速看一眼刚刚做了什么 |
| `/sandbox` | 切换 sandbox 模式 |
| `/powerup` | 用交互式 lesson 了解内建能力 |
| `/rewind` | 回退到 checkpoint |
| `/undo` | `/rewind` 的别名 |
| `/resume` | 恢复以前的 session |
| `/team-onboarding` | 生成一份适合新同事的 Claude Code 上手说明 |
| `/tui` | 切换全屏 TUI（Text User Interface）模式 |
| `/ultraplan` | 先产出详细计划，再在浏览器中审阅 |
| `/ultrareview` | 用云端多代理做一轮更重的综合代码审查 |
| `/usage` | 查看 plan 用量与限流状态 |

这些命令不用安装，开箱即用。

> 截至 2026 年 4 月，上游内建命令已经到了 **60+**。这里保留的是中国小白最该先掌握的一批。

---

## 本目录里的示例命令

| 文件 | 触发方式 | 用途 |
|------|----------|------|
| `optimize.md` | `/optimize` | 分析性能与优化机会 |
| `pr.md` | `/pr` | 提交 PR 前的整理与检查 |
| `generate-api-docs.md` | `/generate-api-docs` | 生成 API 文档 |
| `commit.md` | `/commit` | 生成提交说明 |
| `push-all.md` | `/push-all` | stage + commit + push |
| `doc-refactor.md` | `/doc-refactor` | 文档重构 |
| `setup-ci-cd.md` | `/setup-ci-cd` | CI/CD 初始化 |
| `unit-test-expand.md` | `/unit-test-expand` | 扩充测试覆盖 |

---

## 怎么安装

### 安装全部示例命令

```bash
mkdir -p .claude/commands
cp 01-slash-commands/*.md .claude/commands/
```

### 安装单个命令

```bash
mkdir -p .claude/commands
cp 01-slash-commands/optimize.md .claude/commands/
```

然后在 Claude Code 中直接输入：

```text
/optimize
```

---

## command 文件里哪些不能翻

这一点非常重要。`*.md` 里的说明文字可以中文化，但这些内容不要翻：

- frontmatter key，例如 `description`、`allowed-tools`
- 真实命令名，例如 `/optimize`
- `Bash(...)` 权限约束
- 代码块里的可执行命令

例如 [`pr.md`](./pr.md) 里的这些行必须保留：

- `allowed-tools:`
- `Bash(git add:*)`
- `Bash(git status:*)`
- `Bash(git diff:*)`

---

## 推荐你先用哪几个

如果你是第一次认真用 Claude Code，优先试这几个：

### `/optimize`

适合你想让 Claude 帮你看性能问题、内存问题、算法改进时。

### `/pr`

适合你准备发 PR 前做一次结构化检查，顺手整理提交信息。

### `/generate-api-docs`

适合后端或接口项目，尤其是你已经有一些固定的接口风格想统一输出文档时。

### `/ultraplan`

适合复杂任务。它会先帮你产出更完整的计划，再进入浏览器审阅或继续执行，特别适合多文件改动和高风险任务。

### `/team-onboarding`

适合团队刚开始把 Claude Code 用进项目时。它会根据你当前项目里的 `CLAUDE.md`、skills、subagents、hooks 等实际配置，生成一份给新同事看的 ramp-up guide。

如果你已经把仓库的协作方式写进了 memory，这个命令会特别省时间。

---

## April 2026 这批命令变化，最值得知道什么

- `/pr-comments` 已移除；现在更推荐直接让 Claude 查看 PR 评论
- `/vim` 已移除；编辑器模式改从 `/config` 里设置
- `/powerup` 新增，用交互式 lesson 带你认识 Claude Code 的能力
- `/tui` 新增，适合 tmux / 全屏终端里的无闪烁 TUI 模式
- `/focus` 新增，用来切换只显示重点输出的 focus view
- `/recap` 新增，适合回来继续旧 session 时快速补上下文
- `/undo` 新增，作为 `/rewind` 的别名
- `/proactive` 新增，作为 `/loop` 的别名
- `/ultrareview` 新增，用云端多代理做综合代码审查
- `/less-permission-prompts` 新增，会分析常见 Bash / MCP 调用并帮你减少重复权限提示
- `/effort` 现在多了 `xhigh`，在 Opus 4.7 上成为默认档位
- Max 用户在 Opus 4.7 上使用 Auto Mode 时，不再强依赖 `--enable-auto-mode`
- `/team-onboarding` 新增，适合自动生成团队上手说明
- `/ultraplan` 新增，适合端到端计划工作流
- `/schedule` 更偏向 Cloud scheduled tasks，不再只是本地提醒
- `/init` 的交互增强模式现在更常见的写法是 `CLAUDE_CODE_NEW_INIT=1`

---

## slash commands 和 skills 的关系

很多人一开始会混：

- slash commands：更像“我主动输入一个命令，触发一个固定动作”
- skills：更像“Claude 在合适的时候自动调用的复用能力”

简单理解：

- 想自己明确触发：先用 slash commands
- 想让 Claude 自动判断是否该启用：再考虑 skills

---

## 什么时候该升级成 skill

如果你发现某个 slash command 出现这些情况，就可以考虑迁移到 skill：

- 你在多个项目里都要重复用
- 它不只是一个短 prompt，还依赖脚本、模板、参考文档
- 你希望 Claude 在合适场景下自动调用，而不是每次手动输入

下一步可以看 [03-skills](../03-skills/)。

---

## 常见坑

### 1. 文件放对了，但命令不生效

优先检查：

- 路径是不是 `.claude/commands/`
- 文件扩展名是不是 `.md`
- frontmatter 格式是不是正确

### 2. 翻译后命令坏了

最常见是把这些东西翻译掉了：

- `description`
- `allowed-tools`
- `/command-name`

### 3. 以为 command 和 skill 是两套完全不同的东西

不是。现在推荐实践是更偏向 skill，只是调用方式和使用时机不同。

### 4. 看到旧资料还在用 `/pr-comments` 或 `/vim`

这类写法大多已经过时。遇到老截图、老博客时，优先以当前版本的 `/help` 和官方 CLI 行为为准。

---

## 推荐下一步

- 刚会用 slash commands：去看 [02-memory](../02-memory/)
- 想做自动触发工作流：去看 [03-skills](../03-skills/)
- 想快速查命令：回到 [QUICK_REFERENCE.md](../QUICK_REFERENCE.md)
