# Coffee CLI 项目专属规则

跟随仓库 commit，随 branch 一起流转。补充 `~/.Codex/AGENTS.md` 的全局规则；冲突时以全局规则为准。

---

## 发版检查清单

默认顺序：**整批审查并修复 → 自动化回归与五平台检查 → 构建安装包并上传草稿 → 核对全部产物 → 正式发布 → 核对远程版本与更新日志**。

### 整批审查

- 用户要求 code-review 或发布时，检查本次待交付的整批改动及关联交互，不只检查最后一个小修复。先确认分支、提交范围和未提交内容，保护其他人的修改，不顺带重构无关模块。
- 根据本批改动覆盖相关边界：缓存与后台刷新、首次启动和未安装状态、目录失效、配置写入与关闭后的清理、并发切换与取消、会话关闭与进程退出、主题／多语言、跨平台路径和权限。
- 真实缺陷应补充能复现问题的回归，再修复生产逻辑；交互时序问题不能靠任意延时、放宽断言或删除测试掩盖。新增回归须进入统一测试入口，不以历史测试数量作为免检依据。
- 发版执行下列全套验证；普通提交按影响范围验证。纯文档修改核对差异与实际流程即可，不必重跑无关功能测试。需要真实账号、另行安装的工具或特定机器的实测单独报告，不把模拟服务检查写成真实工具实测。

### 统一验证入口

发布前使用统一入口，避免手写脚本名单漏掉新功能：

- 前端：在 `src-ui` 执行 `npm run build`、`npm run lint`、`npm test`、`npm run test:browser`、`npm audit --audit-level=high --omit=dev`；浏览器首次运行前执行 `npx playwright install chromium`，Linux CI 按工作流安装系统依赖。
- 后端：`cargo check --locked`、`cargo clippy --locked --all-targets --all-features -- -D clippy::correctness -D clippy::suspicious`、`cargo test --locked --no-fail-fast`。
- 原生编排协议：构建当前可执行文件后，通过 `COFFEE_TEST_EXE` 指定它，在 `src-ui` 执行 `npm run test:native`；各发布平台打包后、上传前也要验证最终编译出的程序。此测试只连接本地模拟服务，不启动真实工具任务。
- 主分支／PR 的 Review 和 Release 的 quality 均须包含前端构建、Lint、回归、依赖审计及 Rust 检查和测试；原生编排协议由 Release 的 quality 和各平台产物检查覆盖。quality 失败不得进入安装包构建。手动真实账号测试和基准测试不纳入自动入口。
- 五平台检查覆盖 Windows x64、macOS ARM64／Intel、Linux x64／ARM64。发版必须核对实际发布提交对应的 Review 与 Release 结果，等待必要作业全部成功；触发 CI、开始编译或仅本机通过都不算发布完成。
- 全仓格式与普通 Clippy 风格警告存在历史基线；新增正确性／可疑行为错误必须阻止发布，不为消除风格警告顺带重构无关模块。

### 版本、提交与构建

每次发 Coffee CLI 新版本严格按照这 5 步，一步都不能省：

1. **三处版本号同步**到同一个 SemVer 值：
   - `Cargo.toml` → `[package].version`
   - `tauri.conf.json` → `version`
   - `Cargo.lock` → 项目自身的 package version；先运行不带 `--locked` 的 `cargo check` 自动同步，再执行锁定检查，不手改锁文件。
2. **本地完整验证** — 运行上述统一验证入口；推送后继续核对实际发布提交的五平台 Review 与 Release 结果，全部成功后才能公开发布。
3. **Conventional Commit**：
   - 功能/修复 commit 用 `feat(area):` / `fix(area):`
   - 最后一个版本 commit 是 `chore(release): v<x.y.z>`
   - Commit message 英文，不含网站（Web-Home）相关内容
4. **Tag + Push 触发 CI**：
   - `git tag v<x.y.z>` 打在 release commit 上
   - `git push origin main && git push origin v<x.y.z>`
   - 正常发版通过 Tag push 触发 CI Release workflow；仅 push commit 不会触发安装包发布流程
5. **验证 CI 权限** — 确保 workflow 配置里有 `permissions: contents: write`（踩过 GITHUB_TOKEN 只读的坑）

### 草稿与产物核对（公开前必做）

- 安装包先上传到 Release 草稿，等所有必要 CI 作业结束并确认成功，再公开发布。用户授权发布版本包含最终公开草稿步骤，不重复请求确认；普通开发或文档修改不自动授权发版。
- 八个安装包必须齐全：Windows x64 的 EXE／MSI，macOS ARM64／Intel 的 DMG，Linux x64／ARM64 各自的 DEB／RPM。核对版本、平台命名、上传完成状态和非空文件，实际下载全部安装包，计算 SHA-256 并与 GitHub 资产摘要逐一比较；Windows MSI 还需核对包内 ProductVersion。
- 已推送标签的候选版本若查出真实缺陷，停止出包并保持未公开；修复后使用新版本和新标签，不改写已推送标签，不公开已知有问题的候选包。

### 更新日志（每次发布必做）

- 更新 `install/release-notes-template.md` 的五种语言内容，所有标题版本必须与本次版本一致；`node src-ui/scripts/run-release-notes-test.mjs` 会检查内置日志与应用版本。每次只简要记录本版本的新增、改进与修复，不沿用旧版完整说明，也不累加旧版本内容。
- Release 草稿与客户端内置日志使用同一份模板。安装包全部上传并验证后再正式发布；授权发布版本时包含这一步。
- 正式发布后，`.github/workflows/bump-version-json.yml` 自动将 Release 的版本号、发布时间和正文写入远程 JSON 的 `version`、`releaseDate`、`releaseNotes` 字段，再触发部署；正常发版不手改远程 JSON。
- 发布完成须核对 GitHub latest 指向本版、八个安装包齐全、Release 正文与五语言内置模板一致，以及版本同步工作流和部署成功。读取正式 `https://coffeecli.com/version.json`，确认 `version`、`releaseDate`、`releaseNotes` 与 Release 一致；工作树干净时快进同步机器人提交，最终报告发布链接、验证结果和未实测范围。
- 首次安装或升级按已安装版本展示一次，旧版客户端不能提前展示新版日志。

**版本号自增规则**：

- **默认每次发版都 patch+1**，无论 feat / fix / chore，一视同仁
- **不要按 SemVer 跳 minor**：用户看不到 v2.5.x → v2.6.0 的 "minor 语义"，他们看到的就是"又有更新"。直接跳 minor = 浪费 v2.5.2 ~ v2.5.9 这 8 个号
- **禁止两位 patch**：`v2.5.9` 后下一个发 `v2.6.0`（不是 `v2.5.10`）。这是触发 minor bump 的**唯一**条件
- 反例：v2.5.1 加了 Changes tab 新功能就发 v2.6.0 ❌ —— 应该发 v2.5.2 ✅。已踩过这个坑（2026-05-08）

### version.json 已不再手动维护（v1.0.2+）

旧的"第 6 步——改 `Web-Home/version.json` 为新版本号"已经**废弃并删除**。

历史问题：静态 version.json 在 tag push 的瞬间就指向新版，但 CI 构建各平台安装包要 15-20 分钟；用户在这窗口内跑 `install.ps1`，脚本能读到 "Latest: v1.x.y" 但 `/download/windows` 返回 404——糟糕体验。

新架构（`Web-Home/_worker.js` 的 `/version.json` 路由）：
- CF Worker 查 GitHub API latest release
- 支持 `?platform=windows|macos-arm|linux-deb|linux-appimage`
- **只有该平台的安装包实际上传到 GitHub Releases 后，才返回新版号**；否则返回空字符串，install 脚本识别为"无升级"优雅退出
- 两份 install 脚本（`install.ps1` + `install.sh`）都升级了容错：空版本 / 下载失败时打印"CI 还在编译，15 分钟后再试"，不抛 PowerShell/bash 异常栈

结果：发版时**零手动 version.json 维护**，用户侧**零时间差**。

---

## 剪贴板 I/O：只走 `src-ui/src/lib/clipboard.ts`

WebView2 对 `navigator.clipboard.*` 和 `document.execCommand('copy'|'paste')` 会弹原生权限框（"tauri.localhost 想要查看剪贴板…"），每次右键粘贴都弹一次，UX 极差。同一个坑已经在 Explorer、TierTerminal、Gambit 修过 3 次，第 4 次不能再发生。

**硬规则**：
- 需要读/写剪贴板一律 `import { clipboardRead, clipboardWrite } from '@/lib/clipboard'`（内部走 Tauri `plugin-clipboard-manager`，不弹框）
- **禁止**在 `src-ui/src/` 下直接出现 `navigator.clipboard`、`document.execCommand('copy')`、`document.execCommand('paste')`、或 `from '@tauri-apps/plugin-clipboard-manager'`
- 唯一例外：`lib/clipboard.ts` 自己的实现
- Review / 自检时用 `grep -rn "navigator.clipboard\|plugin-clipboard-manager" src-ui/src` 确认只命中 `lib/clipboard.ts`

---

## Tauri 前端要点

- **用 `import()` 不用 `require()`**：Tauri API 如 `convertFileSrc`、`readTextFile` 等必须 dynamic import，否则 TS build 会报错
- **本地资源加载走 `assetProtocol`**：在 `tauri.conf.json` 配 `app.security.assetProtocol.enable: true` + `scope` 列允许的路径；**不要**盲加 `fs:allow-read-file` 权限（需要 `tauri-plugin-fs` 插件才行，而这个项目没装）
- **xterm 插件先查 peer 依赖**：`@xterm/*` 生态包（addon-canvas、addon-webgl、addon-fit 等）的 peer dep 经常和当前 xterm 主版本不对齐；盲 `npm install` 导致 CI 失败过一次。安装前：
  ```bash
  npm view @xterm/<addon> peerDependencies
  ```
  确认和现有 `@xterm/xterm` 版本兼容再装

---

## 项目基础设施参考

- **分支策略**：只用 `main`，master 已删。install 脚本硬编码 `raw.githubusercontent.com/.../main/...`
- **安装脚本双位置**：`install/` 和 `Web-Home/` 各一份，改动必须同步两处（CF Worker 路由根据路径分发）
- **CF Worker 路由**：`coffeecli.com/version.json` 打到 Web-Home 静态；`coffeecli.com/download/<platform>` 走 Worker 重定向到 GitHub Releases
- **PTY 锁死根因 #1 已修**（v0.6.1）：child watcher 线程；若复现视为根因 #2（emit/channel backpressure），看 `src/terminal.rs` reader 线程
- **Hook forwarder 纪律**（v3.2.5+）：`__hook` 全路径 exit 0；`argv[1]` 以 `__` 开头但不认识的子命令也 exit 0（不起 GUI），防止"新配置 + 旧 exe"时 hook 报 exit 1。Claude hook 条目按 Git Bash 是否可探测写两种形态（`claude_hook_entry`）：有 Git Bash → `"shell": "bash"` + 引号命令；没有 → `"shell": "powershell"` + `& "..." __hook`——Windows 上 Claude 检测不到 Git Bash 会 fallback PowerShell，而 PowerShell 把引号开头的命令串当表达式直接 ParserError exit 1。排查 hook 问题用 `COFFEE_HOOK_DEBUG=1`，日志在 `~/.coffee-cli/hooks/hook-debug.log`
