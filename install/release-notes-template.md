<details open>
<summary><b>🇨🇳 简体中文</b></summary>

### Coffee CLI v3.5.3

- **补上 Cline 启动入口。** 修复 Cline 未出现在 Agent 选择列表的问题，恢复选择与置顶操作。
- **扩展 Orca 残留清理。** 启动时清理已识别的 Orca hook 和插件，补齐 Pi、Oh-My-Pi、Prime Agent 等扩展及旧版配置、备份中的残留；Orca 正在运行时跳过。
- **保留用户配置与数据。** 清理保留用户 hook、扩展、登录信息和会话记录，处理混合 JSONC 配置、Windows 编码命令及 TOML 路径转义，并修正 Codex 清理后的 hook 信任记录索引。

</details>

<details>
<summary><b>🇬🇧 English</b></summary>

### Coffee CLI v3.5.3

- **Restore Cline in the launchpad.** Cline appears in the agent picker again, with selection and pin controls restored.
- **Expand Orca residue cleanup.** Startup cleanup removes recognized Orca hooks and plugins, including Pi, Oh-My-Pi, and Prime Agent extensions, legacy configuration entries, and backup residue. Cleanup is skipped while Orca is running.
- **Preserve user configuration and data.** Keep user hooks, extensions, credentials, and sessions while handling mixed JSONC files, Windows encoded commands, and escaped TOML paths. Codex hook trust indices stay aligned after cleanup.

</details>

<details>
<summary><b>🇹🇼 繁體中文</b></summary>

### Coffee CLI v3.5.3

- **補回 Cline 啟動入口。** 修復 Cline 未出現在 Agent 選擇清單的問題，恢復選擇與置頂操作。
- **擴充 Orca 殘留清理。** 啟動時清理已識別的 Orca hook 與外掛，補齊 Pi、Oh-My-Pi、Prime Agent 等擴充及舊版設定、備份中的殘留；Orca 執行中時跳過。
- **保留使用者設定與資料。** 保留使用者 hook、擴充、登入資訊與工作階段，處理混合 JSONC 設定、Windows 編碼命令及 TOML 路徑跳脫，並修正 Codex 清理後的 hook 信任記錄索引。

</details>

<details>
<summary><b>🇯🇵 日本語</b></summary>

### Coffee CLI v3.5.3

- **Cline の起動項目を復元。** エージェント選択一覧に Cline が表示されない問題を修正し、選択とピン留めを復元しました。
- **Orca の残留ファイルのクリーンアップを拡充。** 起動時に識別可能な Orca の hook やプラグインを削除します。Pi、Oh-My-Pi、Prime Agent の拡張機能、旧設定やバックアップ内の残留項目にも対応。Orca の実行中はスキップします。
- **ユーザーの設定とデータを保持。** ユーザーの hook、拡張機能、認証情報、セッションを保持し、混在した JSONC 設定、Windows のエンコード済みコマンド、TOML パスのエスケープを処理します。削除後の Codex hook の信頼記録のインデックスも整合させます。

</details>

<details>
<summary><b>🇰🇷 한국어</b></summary>

### Coffee CLI v3.5.3

- **Cline 실행 항목 복원.** 에이전트 선택 목록에서 Cline이 누락된 문제를 수정하고 선택 및 고정 기능을 복원했습니다.
- **Orca 잔여 항목 정리 확대.** 시작 시 식별된 Orca hook과 플러그인을 정리합니다. Pi, Oh-My-Pi, Prime Agent 확장과 이전 설정 및 백업의 잔여 항목도 처리하며, Orca 실행 중에는 건너뜁니다.
- **사용자 설정과 데이터 보존.** 사용자 hook, 확장, 인증 정보와 세션을 유지하면서 혼합 JSONC 설정, Windows 인코딩 명령과 TOML 경로 이스케이프를 처리합니다. 정리 후 Codex hook 신뢰 기록의 인덱스도 올바르게 맞춥니다.

</details>