<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../resources/logos/claude-howto-logo-dark.svg">
  <img alt="Claude How To" src="../resources/logos/claude-howto-logo.svg">
</picture>

# Skills 指南

skills 是 Claude Code 里最值得认真掌握的能力之一。它们让 Claude 不再只是“每次重新听你描述要求”，而是能在合适场景下自动拿出一套固定工作流、模板和最佳实践。

---

## skills 是什么

你可以把 skill 理解成：

- 一个带 frontmatter 的 `SKILL.md`
- 可附带脚本、模板、参考资料
- 会被 Claude 自动发现和按需加载
- 更适合长期复用的工作流能力

和普通 prompt 相比，skills 更稳定、更易复用，也更适合团队共享。

---

## skills 为什么重要

当你开始频繁做这些事时，skills 的价值就非常明显：

- 代码审查
- 文档生成
- 代码重构
- 品牌语气统一
- 项目初始化或规范生成

如果每次都靠你手打一大段提示词，既累，也不稳定。skill 的目标就是把这部分沉淀下来。

---

## 一个 skill 的基本结构

```text
skill-name/
├── SKILL.md
├── templates/
├── scripts/
└── references/
```

### `SKILL.md` 负责什么

- 定义 skill 名称
- 说明 skill 在什么情况下应该触发
- 告诉 Claude 该怎么做

### 其他目录负责什么

- `templates/`：输出模板
- `scripts/`：辅助脚本
- `references/`：参考规则或背景知识

---

## April 2026 这批 skills 更新，最值得知道什么

- skill description 的预算更紧了：默认只占上下文窗口的 **1%**，fallback 约 **8,000 字符**
- 即使装了很多 skills，**skill 名称会保留**，description 则会被裁短
- 如果你希望某个 skill 只在某些路径下自动触发，可以在 frontmatter 里加 `paths`
- 写 description 时要把“最关键的使用场景”放前面，否则容易在预算裁剪时丢失重点

---

## progressive disclosure 是什么意思

skills 的一个核心优点是按需加载，而不是一上来把所有内容都塞进上下文里。

简单理解：

1. Claude 先只知道有哪些 skills，以及它们大概干什么
2. 真正需要某个 skill 时，再读取 `SKILL.md`
3. 只有在需要时，才进一步读模板、脚本或参考资料

这意味着你可以装很多 skills，而不会一开始就把上下文塞爆。

上游这次还顺手把技能加载流程图的分层写得更清楚了。现在更推荐这样理解：

- 第 1 层：先看 skill 名称和 description
- 第 2 层：真正命中时再读 `SKILL.md`
- 第 3 层：只有确实需要时，才继续读 `templates/`、`scripts/`、`references/`

这个分层对中文用户特别重要，因为它能解释一个常见疑问：

- 为什么我装了很多 skills，但 Claude 不会一上来全读？

答案就是：Claude 默认按层加载，而不是整包吞下。

---

## skills 放哪里

| 类型 | 路径 | 适合什么 |
|------|------|----------|
| 个人级 | `~/.claude/skills/<skill-name>/SKILL.md` | 个人工作流 |
| 项目级 | `.claude/skills/<skill-name>/SKILL.md` | 团队共享 |
| plugin 自带 | `<plugin>/skills/...` | 和 plugin 一起分发 |

---

## 本目录里的示例 skills

| skill | 位置 | 用途 |
|-------|------|------|
| `code-review` | `03-skills/code-review/` | 代码审查 |
| `brand-voice` | `03-skills/brand-voice/` | 文案风格统一 |
| `doc-generator` | `03-skills/doc-generator/` | 文档生成 |
| `refactor` | `03-skills/refactor/` | 结构化重构 |
| `claude-md` | `03-skills/claude-md/` | 生成或调整 `CLAUDE.md` |

---

## 如何安装

### 安装到个人目录

```bash
mkdir -p ~/.claude/skills
cp -r 03-skills/code-review ~/.claude/skills/
```

### 安装到项目目录

```bash
mkdir -p .claude/skills
cp -r 03-skills/code-review .claude/skills/
```

---

## `SKILL.md` 里哪些不能翻

这点是本地化时最容易翻坏的地方。下面这些字段要保留原样：

- `name`
- `description`
- `effort`
- `shell`
- `paths`

同时，skill 名称本身也不要擅自中文化改名。

### `paths` 是什么

这是新版里很实用的一个 frontmatter 字段，用来限制 skill 只在某些目录或文件模式下触发，例如：

```yaml
paths: "src/api/**/*.ts"
```

如果你已经开始做团队级 skills，这个字段很值得用。

---

## skills 和 slash commands 的区别

### 更适合用 skill 的情况

- 你希望 Claude 自动判断什么时候该触发
- 你需要附带模板、脚本、参考资料
- 这是一个长期工作流，而不是一次性快捷命令

### 更适合用 slash command 的情况

- 你希望自己手动明确触发
- 它更像一个短促的操作入口
- 你希望用户一眼知道“我要输入哪个命令”

---

## 如何写出更好用的 skill

- `description` 要具体，不要空泛
- 一个 skill 聚焦一类问题，别做成“大杂烩”
- 如果依赖脚本或模板，放进 skill 目录，不要散落各处
- 优先写“什么时候触发”和“输出长什么样”

---

## 常见坑

### 1. description 写得太泛

Claude 就不知道什么时候该用它，或者会误触发。

### 2. 把 skill 写成一大段散文

推荐写成结构化说明，让 Claude 更容易执行。

### 3. 把 frontmatter key 翻译掉

这会直接让 skill 无法正确解析。

### 4. description 把重点写在后面

现在 description 预算更紧，Claude 可能先看到的是前半句。最该写在前面的，是“什么时候调用它”。

---

## 中国用户特别注意

- skill 里如果调用 shell 脚本，先确认本机 shell 环境。
- 如果脚本依赖 `python`、`node`、`uv`、`npm`，建议在 skill 说明里提前写明。
- Windows 用户优先考虑 PowerShell / Git Bash / WSL 差异。

---

## 新增的安全护栏：禁用 skill 里的 shell 替换

skill 里支持 ``!`command` `` 这种写法：Claude 在真正读取 skill 前，会先执行 shell 命令，把输出拼进 prompt。

这很强，但在更敏感的环境里也会带来风险。上游现在给了一个更明确的总开关：

```json
{
  "disableSkillShellExecution": true
}
```

开启后：

- ``!`command` `` 不再执行
- 会被当作普通文本保留
- skill 还能继续用，但少了一层 shell 注入面

如果你是在团队、CI 或更受控的环境里推广 skills，这个设置很值得知道。

---

## 推荐下一步

- 想让任务分工更专业：看 [04-subagents](../04-subagents/)
- 想在工具调用前后做自动动作：看 [06-hooks](../06-hooks/)
- 想继续用中文规范扩写：看 [LOCALIZATION-STYLE.md](../LOCALIZATION-STYLE.md)
