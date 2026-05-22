<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../resources/logos/claude-howto-logo-dark.svg">
  <img alt="Claude How To" src="../resources/logos/claude-howto-logo.svg">
</picture>

# Memory 指南

memory 是 Claude Code 中最容易被低估的一项能力。很多人觉得自己只是“加了个 `CLAUDE.md`”，实际上它影响的是 Claude 在每次进入项目时会自动带上的长期上下文。

---

## memory 是什么

Claude Code 的 memory 主要依赖文件系统中的 `CLAUDE.md` 体系。你可以把它理解成：

- 项目规则入口
- 团队约定入口
- 个人偏好入口
- 某个目录下的局部规则入口

它和“当前对话里的临时上下文”不同，memory 更像是长期生效的规则层。

---

## 什么时候最该先配 memory

以下情况非常值得先配 `CLAUDE.md`：

- 你每次都要重复告诉 Claude 代码风格
- 团队里有固定约定，例如测试要求、命名规范、Git 流程
- 项目目录复杂，希望 Claude 一进来就知道哪些目录干什么
- 你想把一部分项目知识长期保存下来，而不是每次重新解释

---

## 高价值命令

| 命令 / 写法 | 用途 |
|-------------|------|
| `/init` | 初始化项目 memory |
| `/memory` | 查看或编辑 memory |
| 自然语言告诉 Claude“记住这条规则” | 让 Claude 帮你更新合适的 memory |
| `@README.md` | 在 `CLAUDE.md` 中引用外部文档 |

---

## April 2026 这批 memory 更新，最值得知道什么

- `/init` 的增强交互模式，推荐写法从 `CLAUDE_CODE_NEW_INIT=true` 逐步统一到了 `CLAUDE_CODE_NEW_INIT=1`
- `CLAUDE.local.md` 现在已经是官方文档里明确支持的个人项目记忆，不再只是“可能还能用的旧特性”
- auto memory 在会话开始时会加载 `MEMORY.md` 的前 200 行，**或者前 25KB**，以先到者为准
- subagents 也可以拥有自己的 auto memory，适合长期复杂项目
- 旧教程里常见的 `# ...` inline memory 快捷写法已经停用；现在请改用 `/memory` 或直接用自然语言让 Claude 记住

如果你是中国用户，这几条很重要，因为网上很多旧教程还停留在更早的说法。

---

## 最快上手方式

### 方法 1：直接复制项目模板

```bash
cp 02-memory/project-CLAUDE.md ./CLAUDE.md
```

### 方法 2：让 Claude 帮你初始化

```bash
CLAUDE_CODE_NEW_INIT=1 claude
/init
```

这通常适合新项目起步时使用。

### 方法 3：直接打开 `/memory` 编辑

```bash
/memory
```

这会直接打开 memory 文件，让你手工改最稳。

### 方法 4：直接用自然语言告诉 Claude 要记住什么

```text
记住：这个项目提交前总是先跑测试。
请加到 memory：优先用 async/await，不要堆 promise chain。
```

Claude 会根据你的描述，把内容写进合适的 `CLAUDE.md`。

> 旧资料里如果还在教你用 `# Always run tests before commit` 这种前缀写法，可以直接把它视为历史写法。现在请改用 `/memory` 或自然语言更新 memory。

---

## 常见 memory 类型

### 项目级 memory

位置通常是：

- `./CLAUDE.md`
- 或 `.claude/CLAUDE.md`

适合放：

- 项目背景
- 目录结构
- 技术栈
- 代码规范
- 测试规则
- 提交和 PR 规范

### 个人级 memory

位置通常是：

- `~/.claude/CLAUDE.md`

适合放：

- 你的个人编码偏好
- 你习惯的回答风格
- 常用工具和命令约定

如果你希望“这个偏好只对当前项目有效，但又不想提交进 Git”，也可以考虑 `./CLAUDE.local.md`。

### 目录级 memory

适合大型项目或 monorepo，在局部目录下放更细粒度规则。

---

## 写什么最有价值

新手最容易把 `CLAUDE.md` 写成“泛泛而谈的项目介绍”，这价值并不大。更推荐写这些：

- 哪些目录最重要
- 哪些规则最容易被忽略
- 提交前必须做什么
- 哪些工具是本项目默认用法
- 哪些文件不要乱动
- 测试和验证的最低标准

---

## 一个适合小白的最小模板

```md
# 项目记忆

## 项目概览
- 这是一个 TypeScript Web 应用。

## 开发规则
- 提交前先运行测试。
- 优先使用 async/await。
- API 变更必须同步更新文档。

## 重要路径
- `src/` 主要应用代码
- `tests/` 自动化测试
- `docs/` 文档
```

---

## 哪些内容不适合写进 memory

- 过长、每次都不一定相关的大段背景知识
- 会频繁变化的实时数据
- 明显更适合做成 skill 或 hook 的工作流细节
- 会影响运行的命令名或配置 key 的中文重命名

如果你发现某段内容更像“流程模板”，通常更适合去做 skill，而不是塞进 `CLAUDE.md`。

---

## 关于 auto memory，再多记两件事

### 1. 启动时不是整份都加载

Claude Code 不会把整个 auto memory 目录一次性全塞进上下文。最先进入上下文的是 `MEMORY.md` 的前 200 行或前 25KB，其余 topic files 按需加载。

### 2. 它不是手工 `CLAUDE.md` 的替代品

- `CLAUDE.md` 更适合明确规则
- auto memory 更适合 Claude 在长期使用中自己沉淀项目知识

二者搭配使用效果最好。

---

## 中国用户特别注意

- 如果你在 Windows 上工作，路径规则和 shell 说明最好明确写清楚。
- 如果项目依赖 `uv`、`npm`、`pnpm`、`bun` 等特定工具，也建议写入 memory。
- 如果项目所在团队有 GitHub、内网、代理、镜像源要求，也值得写在 memory 里。

---

## 这轮 settings 更新里，最值得知道什么

### 1. `/config` 现在会真正落盘

上游在 `v2.1.119` 明确了一个很关键的行为：

- 你在 `/config` 里改的设置
- 现在会写入 `~/.claude/settings.json`
- 并参与正常的 project / local / policy / user 优先级链

对中国用户来说，这意味着：

- `/config` 不再只是“当前会话临时切一下”
- 你改完之后，后续 session 很可能会继承这些设置
- 如果团队里有统一 managed policy，要注意最终谁覆盖谁

### 2. `cleanupPeriodDays` 不只是管 checkpoints

以前很多人会把它理解成“checkpoint 保留几天”。<br>
现在更准确的理解是：它统一控制 4 类本地缓存的保留周期：

- checkpoints
- `~/.claude/tasks/`
- `~/.claude/shell-snapshots/`
- `~/.claude/backups/`

也就是说，你调这个值时，影响的不只是 rewind 历史，还包括任务、shell 快照和备份清理。

### 3. 几个设置项换了更明确的写法

上游现在更推荐这些新写法：

- `attribution.commit`
- `attribution.pr`
- `voice.enabled`
- `prUrlTemplate`

如果你还在旧资料里看到：

- `includeCoAuthoredBy`
- `voiceEnabled`

把它们视为旧名字即可。新项目和新文档尽量按新版写。

---

## 常见坑

### 1. 以为 memory 越长越好

不是。memory 要优先放高价值、长期稳定、对 Claude 行为影响大的规则。

### 2. 把项目规则和个人偏好全混在一起

推荐区分项目级和个人级，这样更方便团队协作。

### 3. 让 `CLAUDE.md` 和实际仓库脱节

如果项目目录或规范已经变了，要及时更新 memory，否则 Claude 会学到过期规则。

### 4. 还在把 `CLAUDE.local.md` 当“灰色特性”

现在不需要了。它已经是正式支持的个人项目记忆文件；唯一要注意的是把它加进 `.gitignore`。

---

## 推荐下一步

- 想做可复用工作流：看 [03-skills](../03-skills/)
- 想安全试错：看 [08-checkpoints](../08-checkpoints/)
- 想看完整学习顺序：看 [LEARNING-ROADMAP.md](../LEARNING-ROADMAP.md)
