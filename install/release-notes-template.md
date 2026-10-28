<details open>
<summary><b>🇨🇳 简体中文</b></summary>

### Coffee CLI v3.7.9 · 性能与会话恢复优化

- **操作响应：** 将终端、文件和会话的耗时操作移至后台，减少工具启动、标签切换和关闭时的界面阻塞。
- **加载与长对话：** 合并重复探测，后台加载可选能力，复用历史消息布局计算，改善长对话滚动与切换响应。
- **任务发送：** 便签、列表与分类视图支持向当前 Claude／Codex 桌面会话发送；成功后更新状态，失败时保留内容并提示。
- **历史恢复：** Claude Code 和 Codex 恢复历史会话时，跟随卡片选择的 Terminal／Desktop 模式，继续原有对话。
- **稳定性：** 保持终端输入和连续消息的发送顺序，避免旧目录监听或迟到的探测结果影响新状态。

</details>

<details>
<summary><b>🇬🇧 English</b></summary>

### Coffee CLI v3.7.9 · Performance and Session Restoration

- **Responsiveness:** Run slow terminal, file, and session operations in the background to reduce stalls when opening tools, switching tabs, and closing sessions.
- **Loading and long conversations:** Share concurrent probes, load optional capabilities in the background, and reuse historical message layout calculations for smoother scrolling and navigation.
- **Task sending:** Send notes, lists, and categorized prompts to the current Claude or Codex desktop session. Update task status after confirmation and retain content with feedback on failure.
- **History restoration:** Resume Claude Code and Codex conversations using the card's selected Terminal or Desktop mode while preserving the original conversation.
- **Reliability:** Preserve terminal input and message order, and prevent outdated directory watchers or delayed capability checks from overwriting newer state.

</details>

<details>
<summary><b>🇹🇼 繁體中文</b></summary>

### Coffee CLI v3.7.9 · 效能與會話恢復優化

- **操作回應：** 將終端、檔案和會話的耗時操作移至背景，減少工具啟動、分頁切換與關閉時的介面阻塞。
- **載入與長對話：** 合併重複偵測，於背景載入選用能力，重用歷史訊息版面計算，改善長對話捲動與切換回應。
- **任務傳送：** 便箋、列表與分類檢視支援傳送至目前的 Claude／Codex 桌面會話；成功後更新狀態，失敗時保留內容並提示。
- **歷史恢復：** Claude Code 和 Codex 恢復歷史會話時，跟隨卡片選擇的 Terminal／Desktop 模式，繼續原有對話。
- **穩定性：** 保持終端輸入和連續訊息的傳送順序，避免舊目錄監聽或延遲的偵測結果影響新狀態。

</details>

<details>
<summary><b>🇯🇵 日本語</b></summary>

### Coffee CLI v3.7.9 · パフォーマンスと会話復元の改善

- **応答性：** 時間のかかるターミナル・ファイル・会話処理をバックグラウンドで実行し、ツール起動、タブ切り替え、終了時の画面停止を軽減。
- **読み込みと長い会話：** 同時の検出処理を共有し、追加機能をバックグラウンドで読み込み。履歴メッセージのレイアウト計算を再利用し、スクロールと切り替えを改善。
- **タスク送信：** メモ・リスト・分類別プロンプトを現在の Claude／Codex デスクトップ会話へ送信。送信確認後に状態を更新し、失敗時は内容を保持して通知。
- **履歴の再開：** Claude Code と Codex の履歴を、カードで選択した Terminal／Desktop モードで元の会話から再開。
- **安定性：** 入力と連続メッセージの送信順を維持し、古いフォルダー監視や遅れた検出結果による状態の上書きを防止。

</details>

<details>
<summary><b>🇰🇷 한국어</b></summary>

### Coffee CLI v3.7.9 · 성능 및 대화 복원 개선

- **응답성:** 시간이 걸리는 터미널·파일·세션 처리를 백그라운드에서 실행하여 도구 실행, 탭 전환, 세션 종료 시 화면 멈춤을 줄였습니다.
- **로딩과 긴 대화:** 동시 감지 요청을 공유하고 선택 기능을 백그라운드에서 불러옵니다. 이전 메시지의 레이아웃 계산을 재사용하여 스크롤과 전환 반응을 개선했습니다.
- **작업 전송:** 메모·목록·분류별 프롬프트를 현재 Claude／Codex 데스크톱 대화로 전송합니다. 전송 확인 후 상태를 갱신하며 실패 시 내용을 유지하고 안내합니다.
- **기록 복원:** Claude Code와 Codex 기록을 카드에서 선택한 Terminal／Desktop 모드로 열어 기존 대화를 이어갑니다.
- **안정성:** 터미널 입력과 연속 메시지의 전송 순서를 유지하고, 이전 폴더 감시나 지연된 감지 결과가 새 상태를 덮어쓰지 않도록 했습니다.

</details>
