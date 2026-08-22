<details open>
<summary><b>🇨🇳 简体中文</b></summary>

### Coffee CLI v3.4.8

- **T1 现在是一套完整、可操作的桌面体验。** Claude Code、Codex CLI 与 Kimi Code 同时支持灵动岛、泡泡对话以及权限/输入选择卡片；可点击选项，也可继续使用数字键、方向键与回车操作，等待权限与任务完成分别播放正确提示音。
- **权限识别以真实终端结构为准。** Coffee CLI 直接读取各工具已经渲染的终端单元格和经过验证的原生状态，不依赖 Hook 或模型猜测；普通回复中的 1/2/3/4、编号列表和相似文本不会被当成选择。未验证的工具保持完整原生终端体验，不再显示不可靠的伪灵动岛或泡泡入口。
- **Codex Desktop 历史标题恢复准确。** 会话列表会跳过插件目录、AGENTS、环境信息和附件包装等系统注入内容，并从真正的第一条用户请求生成标题。
- **长对话导航始终保持视觉居中。** 左侧刻度会在可见对话区域内居中，并自动扣除 Gambit 输入区；当前轮次也会稳定滚到刻度栏中部，拖动 Gambit 高度后仍保持正确位置。

</details>

<details>
<summary><b>🇬🇧 English</b></summary>

### Coffee CLI v3.4.8

- **T1 is now a complete, interactive desktop experience.** Claude Code, Codex CLI, and Kimi Code combine Dynamic Island status, Bubble Conversation, and permission/input cards. Choices work by click or by the familiar number keys, arrow keys, and Enter, with distinct sounds for permission waits and completed turns.
- **Interaction detection is grounded in the real terminal UI.** Coffee CLI reads each supported tool's rendered terminal cells and verified native state—without hooks or model guesses. Ordinary 1/2/3/4 output, numbered prose, and look-alike text remain non-actionable. Unverified tools retain their full native terminal experience without unreliable projected status or conversation controls.
- **Codex Desktop history titles are accurate again.** The session list skips injected plugin catalogues, AGENTS instructions, environment blocks, and attachment wrappers, then derives the title from the first genuine user request.
- **Long-conversation navigation stays visually centred.** The prompt rail centres inside the visible conversation viewport, excludes the Gambit composer area, keeps the active turn near the middle, and readjusts live when Gambit is resized.

</details>

<details>
<summary><b>🇹🇼 繁體中文</b></summary>

### Coffee CLI v3.4.8

- **T1 現在是一套完整且可操作的桌面體驗。** Claude Code、Codex CLI 與 Kimi Code 同時支援靈動島、泡泡對話及權限／輸入選擇卡片；可點擊選項，也可繼續使用數字鍵、方向鍵與 Enter，等待權限和任務完成會播放不同的正確提示音。
- **互動識別以真實終端結構為準。** Coffee CLI 直接讀取各工具已渲染的終端單元格與經過驗證的原生狀態，不依賴 Hook 或模型猜測；一般回覆中的 1/2/3/4、編號清單和相似文字不會被當成選擇。尚未驗證的工具保留完整原生終端體驗，不再顯示不可靠的投影狀態或泡泡入口。
- **Codex Desktop 歷史標題恢復準確。** 會話列表會略過外掛目錄、AGENTS、環境資訊與附件包裝等系統注入內容，再由真正的第一則使用者請求產生標題。
- **長對話導覽始終保持視覺置中。** 左側刻度會在可見對話區域內置中並自動扣除 Gambit 輸入區；目前回合會穩定捲到刻度列中部，調整 Gambit 高度後也會即時校正。

</details>

<details>
<summary><b>🇯🇵 日本語</b></summary>

### Coffee CLI v3.4.8

- **T1 が完全に操作できるデスクトップ体験になりました。** Claude Code、Codex CLI、Kimi Code で Dynamic Island、バブル会話、権限／入力カードを同時に利用できます。クリックに加え、数字キー、矢印キー、Enter でも選択でき、権限待ちとタスク完了にはそれぞれ正しい通知音が鳴ります。
- **操作検出は実際のターミナル UI に基づきます。** Coffee CLI は対応ツールが描画したセルと検証済みのネイティブ状態を直接読み取り、Hook やモデルの推測には依存しません。通常の回答に含まれる 1/2/3/4、番号付き文章、類似テキストは選択肢として扱われません。未検証のツールは、不確かな状態表示や会話 UI を追加せず、完全なネイティブターミナルとして動作します。
- **Codex Desktop の履歴タイトルが正確になりました。** プラグイン一覧、AGENTS 指示、環境情報、添付ファイルのラッパーなどの注入ブロックを読み飛ばし、最初の本当のユーザー依頼からタイトルを生成します。
- **長い会話でもナビゲーションが常に中央に保たれます。** 左のプロンプトレールは Gambit 入力領域を除いた表示範囲内で中央に配置され、現在のターンも中央付近へ追従します。Gambit の高さを変更した場合も即座に再調整されます。

</details>

<details>
<summary><b>🇰🇷 한국어</b></summary>

### Coffee CLI v3.4.8

- **T1이 완전하게 조작할 수 있는 데스크톱 경험으로 완성되었습니다.** Claude Code, Codex CLI, Kimi Code에서 Dynamic Island, 버블 대화, 권한/입력 선택 카드를 함께 사용할 수 있습니다. 클릭뿐 아니라 숫자 키, 방향키, Enter로도 선택할 수 있으며 권한 대기와 작업 완료에 서로 다른 올바른 알림음이 재생됩니다.
- **상호작용 감지는 실제 터미널 UI를 기준으로 합니다.** Coffee CLI는 지원 도구가 렌더링한 셀과 검증된 네이티브 상태를 직접 읽으며 Hook이나 모델 추측에 의존하지 않습니다. 일반 답변의 1/2/3/4, 번호 목록, 비슷한 문구는 선택지로 처리되지 않습니다. 검증되지 않은 도구는 신뢰할 수 없는 상태나 대화 UI를 덧씌우지 않고 완전한 네이티브 터미널로 유지됩니다.
- **Codex Desktop 기록 제목이 다시 정확해졌습니다.** 세션 목록은 플러그인 카탈로그, AGENTS 지침, 환경 정보, 첨부 파일 래퍼 같은 주입 블록을 건너뛰고 첫 번째 실제 사용자 요청에서 제목을 생성합니다.
- **긴 대화의 탐색 표시가 항상 시각적으로 중앙에 유지됩니다.** 왼쪽 프롬프트 레일은 Gambit 입력 영역을 제외한 실제 대화 뷰포트 안에서 중앙에 배치되고 현재 턴도 레일 가운데로 따라옵니다. Gambit 높이를 바꾸면 즉시 다시 맞춰집니다.

</details>
