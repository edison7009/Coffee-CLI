# Coffee CLI 远程访问协议（v0）

其他设备（电脑、平板、手机）用浏览器打开 Coffee CLI，看到的是这台电脑完整界面的镜像：标签页、会话、终端、设置和主题都跟随桌面，操作也都交给桌面执行。浏览器自己不运行任何工具，也不另装 App。

- 桌面端：`src/mobile_rpc/`（Rust），前端桥接是 `src-ui/src/components/agent/MobileRpcBridge.tsx`。
- 浏览器端：`src-ui/src/remote/`。`protocol.ts` 实现握手、加密和请求，`bridge.ts` 把桌面界面里的 Tauri 调用换成远程请求。
- 默认关闭，在「设置 → 设备连接」里打开。

## 1. 传输

- 桌面在局域网所有网卡上监听 WebSocket，默认端口 47391，同一个端口也提供浏览器页面（`/?remote`）。
- 配对二维码里的链接是 `http://<地址>:47391/?remote#pair=<配对链接>`。配对链接放在 `#` 后面，不会出现在任何服务器日志里。
- 二维码最多带 3 个局域网地址，检测到异地组网工具（Tailscale、ZeroTier 等）时再加上它的地址，最后附上电脑的 `.local` 名字。浏览器会同时尝试所有地址，用最先连通的那个。配对卡片上另外单独显示异地组网地址，供在外面使用。

## 2. 配对与认证

加密协议是 `Noise_IKpsk2_25519_ChaChaPoly_SHA256`。桌面的静态 X25519 密钥保存在 `~/.coffee-cli/mobile/config.json`，文件权限 0600；已配对设备只保存公钥。

1. 桌面生成配对链接 `coffeecli://pair?v=0&hosts=<地址,…>&port=<端口>&pk=<桌面公钥hex>&code=<128 位一次性码>`。有效期 5 分钟，同一时间只有一个配对码，离开设置页即作废。
2. 浏览器生成自己的静态密钥。WebSocket 的第一条二进制消息是 `[mode] ++ noise_msg1`：
   - `mode=1` 配对：psk = SHA-256(code)。任何一次配对尝试（无论成败）都会让配对码作废。
   - `mode=0` 重连：psk 全零。设备公钥必须在已配对列表里，否则通过加密通道回复 `unauthorized`。
3. 桌面回复 `noise_msg2`。浏览器的第一条加密帧必须是 `hello`。配对时，桌面会弹出对话框请用户按设备名确认，2 分钟内没有允许就视为拒绝。
4. 移除设备会立即断开它的所有连接，之后它再连会收到 `unauthorized`。

每次连接都使用新的会话密钥（前向保密），双方用静态密钥互相认证。

## 3. 帧格式

握手之后，每条 WebSocket 二进制消息承载一段 JSON 明文。明文按 65519 字节切块，每块是一条 Noise 消息，前面加 2 字节大端长度。解密失败或收到文本帧，连接立即断开。

```jsonc
{ "id": 12, "method": "session.list", "params": {} }            // 请求
{ "id": 12, "result": { ... } }                                 // 响应
{ "id": 12, "error": { "code": "not_found", "message": "..." } }
{ "event": "tauri.event", "params": { ... }, "seq": 8812 }      // 桌面推送，无 id
```

- 错误码：`unauthorized` `not_found` `invalid_params` `busy` `unsupported` `internal` `too_large`。
- 浏览器发往桌面的单条请求上限 1 MB（`MAX_FRAME`）；超过时浏览器端直接以 `too_large` 失败，连接不受影响。桌面发往浏览器的消息没有上限。

## 4. 方法

| 方法 | 作用 |
|---|---|
| `hello` / `ping` | 版本协商（`protocol` 必须是 0）与心跳 |
| `session.list` | 桌面的标签页，按桌面顺序，带工具、模式、标题、目录、状态 |
| `ui.subscribe` | 开始接收桌面事件（`tauri.event`），返回转发的事件名单 |
| `ui.invoke` | 以浏览器身份调用桌面命令，先经过 `remote_ui.rs` 的规则检查 |
| `ui.dispatch` | 把标签、设置、草稿等界面动作交给桌面执行 |
| `ui.call` | 调用桌面会话或应用状态上注册的动作（发送消息、更新工具等） |
| `mirror.snapshot` | 取某个会话或应用状态的完整快照，之后按编号接收增量 |
| `ui.storage` | 写入桌面共享的本地存储（最近目录、启动方式等） |
| `ui.terminal.attach` | 镜像一个终端：最近 256 KB 输出、输出结束位置、终端尺寸 |
| `ui.watch` | 为浏览器自己的文件树监听一个目录 |
| `ui.wallpaper` | 分块读取桌面的壁纸（仅限图片和视频，最大 64 MB） |
| `upload.begin` / `chunk` / `finish` | 把浏览器设备上的文件分块传到这台电脑 |

桌面推送：
- `tauri.event`：桌面事件原样转发。终端输出带 `start`/`end` 字节位置，浏览器据此拼接快照和实时输出，发现缺口就重新 attach。
- `session.changed`：标签页列表变了，浏览器重新取 `session.list`。
- 状态镜像的增量补丁按编号送达；浏览器发现缺号就重新取快照。

## 5. 顺序与重连

- 每个连接内部有两条有序通道：终端输入一条；界面动作、存储写入、`ui.call`、`ui.watch`、上传共用另一条。其余请求并行处理。
- 浏览器断线后自动重连，重新握手、`hello`，然后重新取所有快照。
- 连接上限 64 条，同时在线的已配对设备最多 8 台；握手必须在 10 秒内完成。

## 6. 安全边界

- 配对等同于给出 SSH 级别的信任：浏览器能在桌面终端里输入，也就能运行任意命令。设置页的开关说明里已写明。
- `remote_ui.rs` 的规则是为了保护桌面应用本身：窗口控制、本机对话框和声音、密码、安装与自更新、配对开关、打开外部程序、编排中枢都不对浏览器开放；会话的启动、关闭和调整尺寸只能由桌面执行。
- 每条请求都会检查设备是否已被移除。

## 7. 测试

- `src-ui/scripts/run-remote-protocol-test.mjs`：握手、配对链接解析、超大请求、多地址竞速等（`npm test`）。
- `src/mobile_rpc/tests.rs`：真实 socket 上的配对、重连、篡改、移除，以及用 Node 运行浏览器自己的 `protocol.ts` 与桌面互通（`src-ui/scripts/remote-interop.mjs`）。
- `src-ui/scripts/run-remote-*.mjs`：镜像、存储、Web 端页面的回归。
