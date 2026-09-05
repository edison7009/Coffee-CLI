<details open>
<summary><b>🇨🇳 简体中文</b></summary>

### Coffee CLI v3.4.9

- **优化普通终端与泡泡对话的标签切换。** 复用近期标签的终端渲染资源，限制后台缓存数量，减少无关标签重绘和重复尺寸通知；隐藏的长对话保留显示范围与阅读位置。
- **修复 macOS 输入重复。** 修正输入法透传导致空格和大写字母重复发送的问题。
- **修复文件操作与目录切换。** 删除、重命名和移动目录链接时保留目标目录；复制、移动和重命名遇到同名目标会报错，并阻止复制到自身子目录及越界重命名。后台终端切换目录、旧文件列表响应不再改写当前标签。
- **改进对话与 Diff 显示。** 保留 Unix 路径大小写，改善 Markdown 表格布局；打开中的 Diff 原位刷新，内容未变时跳过重复高亮。语法高亮初始化失败后可重试，并保留纯文本显示。
- **减少后台开销并修复 Windows 链接打开。** 清理无人读取的终端输出缓存和未使用依赖，修复异步事件监听器泄漏；Windows 通过系统接口打开链接及本地文件，避免将链接中的特殊字符解释为命令。

</details>

<details>
<summary><b>🇬🇧 English</b></summary>

### Coffee CLI v3.4.9

- **Smoother terminal and Bubble Conversation tab switching.** Reuse recent terminal renderers within a bounded cache, reduce unrelated tab renders and duplicate resize notifications, and retain the visible range and reading position of hidden conversations.
- **Fix duplicate macOS input.** Correct IME passthrough that could send spaces and capital letters twice.
- **Safer file operations and workspace switching.** Deleting, renaming, or moving directory links preserves their targets. Copy, move, and rename reject existing destinations, copying into a source directory is blocked, and rename stays within its parent. Background terminal directory changes and stale file listings no longer replace the active tab's workspace.
- **More reliable conversations and diffs.** Preserve Unix path case and improve Markdown tables. Open diffs refresh in place and skip repeated highlighting when text is unchanged. Failed highlighter initialization can retry while plain text remains available.
- **Less background work and reliable Windows link opening.** Remove an unread terminal output buffer and unused dependencies, clean up late event listeners, and use the native Windows handler for URLs and local files so special characters are not interpreted as shell commands.

</details>

<details>
<summary><b>🇹🇼 繁體中文</b></summary>

### Coffee CLI v3.4.9

- **改善終端與泡泡對話的分頁切換。** 重用近期分頁的終端繪圖資源並限制背景快取數量，減少無關分頁重繪與重複尺寸通知；隱藏的長對話保留顯示範圍及閱讀位置。
- **修正 macOS 重複輸入。** 修正輸入法透傳可能重複傳送空格與大寫字母的問題。
- **修正檔案操作與目錄切換。** 刪除、重新命名或移動目錄連結時保留目標目錄；複製、移動及重新命名遇到同名目標會報錯，並阻止複製到自身子目錄及越界命名。背景終端的目錄變更與過期清單不再改寫目前分頁。
- **改善對話及 Diff 顯示。** 保留 Unix 路徑大小寫並改善 Markdown 表格；開啟中的 Diff 就地更新，內容未變時略過重複上色。語法上色初始化失敗後可重試，並保留純文字顯示。
- **減少背景負擔並修正 Windows 連結開啟。** 清除無人讀取的終端輸出快取及未使用依賴，修正非同步事件監聽器洩漏；Windows 改用系統介面開啟連結與本機檔案，避免將特殊字元解讀為命令。

</details>

<details>
<summary><b>🇯🇵 日本語</b></summary>

### Coffee CLI v3.4.9

- **ターミナルとバブル会話のタブ切り替えを改善。** 最近使った描画リソースを上限付きキャッシュで再利用し、無関係なタブの再描画と重複するサイズ通知を削減。非表示の会話も表示範囲と読んでいた位置を保持します。
- **macOS の二重入力を修正。** IME の入力処理でスペースや大文字が二度送信される問題を修正しました。
- **ファイル操作と作業フォルダー切り替えを修正。** ディレクトリリンクの削除・名前変更・移動でリンク先を保持。同名のコピー先・移動先・変更先を拒否し、自身の子ディレクトリへのコピーや親を越える名前変更を防ぎます。バックグラウンド端末や古い一覧応答が現在のタブのフォルダーを上書きしなくなりました。
- **会話と Diff 表示を改善。** Unix パスの大文字・小文字を保持し、Markdown 表を改善。開いた Diff はその場で更新し、内容が同じなら再ハイライトを省略します。ハイライト初期化は失敗後に再試行でき、プレーンテキスト表示を維持します。
- **バックグラウンド処理と Windows のリンク処理を改善。** 未使用の出力バッファと依存関係を削除し、非同期リスナーの解放漏れを修正。Windows はシステム API で URL とローカルファイルを開き、特殊文字がシェルコマンドとして解釈されるのを防ぎます。

</details>

<details>
<summary><b>🇰🇷 한국어</b></summary>

### Coffee CLI v3.4.9

- **터미널과 버블 대화의 탭 전환을 개선했습니다.** 최근 렌더러를 제한된 캐시 안에서 재사용하고 관련 없는 탭의 렌더링과 중복 크기 알림을 줄였습니다. 숨겨진 대화도 표시 범위와 읽던 위치를 유지합니다.
- **macOS 중복 입력을 수정했습니다.** IME 입력 처리 중 공백과 대문자가 두 번 전송될 수 있던 문제를 해결했습니다.
- **파일 작업과 작업 폴더 전환을 수정했습니다.** 디렉터리 링크를 삭제하거나 이름을 바꾸거나 이동해도 대상 폴더를 보존합니다. 복사·이동·이름 변경 시 동일한 대상이 있으면 오류를 표시하고, 자신의 하위 폴더로 복사하거나 상위 경로를 벗어나는 이름 변경을 차단합니다. 백그라운드 터미널과 오래된 파일 목록이 현재 탭의 폴더를 덮어쓰지 않습니다.
- **대화와 Diff 표시를 개선했습니다.** Unix 경로의 대소문자를 보존하고 Markdown 표를 개선했습니다. 열린 Diff는 현재 화면에서 갱신하며 내용이 같으면 다시 강조하지 않습니다. 구문 강조 초기화에 실패해도 일반 텍스트를 표시하고 재시도할 수 있습니다.
- **백그라운드 부담과 Windows 링크 처리를 개선했습니다.** 사용하지 않는 출력 버퍼와 의존성을 제거하고 비동기 이벤트 리스너 누수를 수정했습니다. Windows는 시스템 API로 URL과 로컬 파일을 열어 특수 문자가 셸 명령으로 해석되지 않도록 합니다.

</details>
