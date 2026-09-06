<details open>
<summary><b>🇨🇳 简体中文</b></summary>

### Coffee CLI v3.5.0

- **减少历史记录的后台扫描开销。** 缓存未变化会话文件的解析结果，减少重复读取大量历史日志；有新内容或被重写的文件仍会完整解析，保持会话信息与消息计数准确。
- **让历史刷新更及时可靠。** 合并连续刷新请求，扫描期间收到的刷新会在完成后补做；会话信息未变化时跳过重复界面更新。
- **减少终端重复尺寸调整。** 根据终端实际尺寸跳过重复通知，保留启动后的尺寸校正和失败重试，并覆盖 Windows、macOS 与 Linux 的不同平台行为。

</details>

<details>
<summary><b>🇬🇧 English</b></summary>

### Coffee CLI v3.5.0

- **Less background work when scanning session history.** Cache parsed results for unchanged session files to avoid repeatedly reading large collections of logs. Appended or rewritten files are still fully parsed to keep session metadata and message counts accurate.
- **More reliable history refreshes.** Coalesce consecutive requests and replay refreshes received during an active scan. Skip redundant interface updates when session data has not changed.
- **Fewer redundant terminal resizes.** Check the actual terminal dimensions before resizing, preserve post-startup size correction and retries after failures, and account for platform differences on Windows, macOS, and Linux.

</details>

<details>
<summary><b>🇹🇼 繁體中文</b></summary>

### Coffee CLI v3.5.0

- **減少歷史記錄的背景掃描負擔。** 快取未變更會話檔案的解析結果，減少重複讀取大量歷史日誌；新增內容或被改寫的檔案仍會完整解析，維持會話資訊與訊息計數的準確性。
- **讓歷史記錄更新更及時可靠。** 合併連續更新請求，掃描期間收到的更新會在完成後補做；會話資訊未變更時略過重複介面更新。
- **減少終端重複尺寸調整。** 根據終端實際尺寸略過重複通知，保留啟動後的尺寸校正與失敗重試，並涵蓋 Windows、macOS 與 Linux 的平台差異。

</details>

<details>
<summary><b>🇯🇵 日本語</b></summary>

### Coffee CLI v3.5.0

- **セッション履歴のバックグラウンド処理を削減。** 変更のないセッションファイルの解析結果をキャッシュし、大量のログの繰り返し読み込みを減らします。追記・書き換えされたファイルは全体を解析し、セッション情報とメッセージ数の正確性を維持します。
- **履歴更新の信頼性を改善。** 連続する更新要求をまとめ、スキャン中に届いた要求は完了後に処理します。セッション情報に変更がなければ、不要な画面更新を省略します。
- **ターミナルの重複サイズ変更を削減。** 実際のサイズを確認して不要な通知を省略し、起動後のサイズ補正と失敗時の再試行を維持します。Windows、macOS、Linux の動作の違いにも対応しています。

</details>

<details>
<summary><b>🇰🇷 한국어</b></summary>

### Coffee CLI v3.5.0

- **세션 기록의 백그라운드 처리 부담을 줄였습니다.** 변경되지 않은 세션 파일의 분석 결과를 캐시해 많은 로그를 반복해서 읽는 작업을 줄입니다. 내용이 추가되거나 다시 작성된 파일은 전체를 분석해 세션 정보와 메시지 수를 정확하게 유지합니다.
- **기록 새로고침의 신뢰성을 높였습니다.** 연속된 요청을 모아서 처리하고, 스캔 중에 받은 새로고침 요청은 완료 후 다시 실행합니다. 세션 정보가 그대로라면 불필요한 화면 갱신을 건너뜁니다.
- **불필요한 터미널 크기 변경을 줄였습니다.** 실제 터미널 크기를 확인해 중복 알림을 생략하고, 시작 후 크기 보정과 실패 시 재시도를 유지합니다. Windows, macOS, Linux의 플랫폼별 동작 차이도 고려했습니다.

</details>

Thanks to @keros68 for the investigation and initial optimizations in [#133](https://github.com/edison7009/Coffee-CLI/pull/133).
