# Coffee CLI 项目专属规则

跟随仓库 commit，随 branch 一起流转。补充 `~/.claude/CLAUDE.md` 的全局规则；冲突时以全局规则为准。

---

## 发版检查清单

每次发 Coffee CLI 新版本严格按照这 5 步，一步都不能省：

1. **三处版本号同步**到同一个 SemVer 值：
   - `Cargo.toml` → `[package].version`
   - `tauri.conf.json` → `version`
   - （Cargo.lock 会在 `cargo check` 时自动更新，不用手改）
2. **build 验证** — `cargo check` + `cd src-ui && npm run build` 两端都要绿灯
3. **Conventional Commit**：
   - 功能/修复 commit 用 `feat(area):` / `fix(area):`
   - 最后一个版本 commit 是 `chore(release): v<x.y.z>`
   - Commit message 英文，不含网站（Web-Home）相关内容
4. **Tag + Push 触发 CI**：
   - `git tag v<x.y.z>` 打在 release commit 上
   - `git push origin main && git push origin v<x.y.z>`
   - Tag push 是 CI Release workflow 的唯一触发条件，仅 push commit 不会触发
5. **验证 CI 权限** — 确保 workflow 配置里有 `permissions: contents: write`（踩过 GITHUB_TOKEN 只读的坑）

**禁止两位 patch**：`0.6.9` → `0.7.0`，不要 `0.6.10`（见全局规则 #5）

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
- **Game Assets**：`.jsdos` 格式，上传到 GitHub Releases `game-assets` tag（非版本 tag）
- **PTY 锁死根因 #1 已修**（v0.6.1）：child watcher 线程；若复现视为根因 #2（emit/channel backpressure），看 `src/terminal.rs` reader 线程
