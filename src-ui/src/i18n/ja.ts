export const ja = {
  'app.title': 'Coffee CLI',
  'explorer.tab.computer': 'マイコンピュータ',
  'explorer.tab.workspace': 'ワークスペース',
  'explorer.workspace.select-dir': '作業フォルダをクリックして選択',

  // Context Menu
  'menu.copy_abs': '絶対パスをコピー',
  'menu.copy_rel': '相対パスをコピー',
  'menu.copy_ref': '@reference としてコピー',
  'menu.cut': '切り取り',
  'menu.copy': 'コピー',
  'menu.paste': '貼り付け',
  'menu.select_all': 'すべて選択',
  'menu.rename': '名前を変更',
  'menu.delete': '削除',
  'menu.show_in_folder': 'エクスプローラーで表示',

  // Drive kinds (Quick Access)
  'drive.desktop': 'デスクトップ',
  'drive.downloads': 'ダウンロード',
  'drive.documents': 'ドキュメント',
  'drive.pictures': 'ピクチャ',
  'drive.music': 'ミュージック',
  'drive.videos': 'ビデオ',
  'drive.home': 'ホーム',
  'drive.drive': '{label} ドライブ',
  'drive.root': 'ルート (/)',
  'drive.volume': '{label}',

  // Tools
  'tool.terminal': 'ターミナル',
  'tool.remote': 'リモートターミナル',
  'tool.remote.short': 'リモート',
  'tool.installer': 'インストーラー',
  'tool.vibeid': '性格診断',
  'tool.insights_prerun': '使用状況レポートを生成中...',
  'vibeid.need_insights_confirm': '性格診断には Claude Code の使用状況レポートが必要です。\n\n/insights を自動実行します（約 1〜2 分）。完了後、性格診断が自動的に開始されます。\n\n続行しますか？',
  'vibeid.insights_timeout': 'レポートの生成がタイムアウトしました。後でもう一度試すか、Claude Code タブで /insights を手動で実行してください。',

  // Remote Terminal
  'remote.title': 'リモートターミナル',
  'remote.host': 'ホスト',
  'remote.host_placeholder': '例: 192.168.1.100',
  'remote.username': 'ユーザー名',
  'remote.password': 'パスワード',
  'remote.connect': '接続',
  'remote.connecting': '接続中...',
  'remote.connect_failed': '接続に失敗しました',

  'tab.new': 'ツールを選択',


  // Task Board
  'task.input_placeholder': 'タスクを入力...',
  'task.notes_placeholder': 'メモを追加...',
  'task.section.working': '進行中',
  'task.section.todo': '未着手',
  'task.section.done': '完了',
  'task.greeting.morning': 'おはようございます。今日の予定は？',
  'task.greeting.afternoon': 'こんにちは。残りのタスクは？',
  'task.greeting.evening': 'こんばんは。何か始めますか？',
  'task.tab.tasks': 'タスク',
  'task.tab.sessions': '履歴',
  'task.default_title': '新しいタスク',
  'task.search_sessions': 'セッションを検索...',
  'menu.no_recent': '最近のセッションはありません',
  'task.turns': '{count} ターン',

  // Actions
  'action.close': '閉じる',
  'action.resume_terminal': 'このセッションを続ける',

  // Time
  'time.just_now': 'たった今',
  'time.today': '今日',
  'time.yesterday': '昨日',
  'time.days_ago': '{days} 日前',

  // Session
  'session.max': '同時に開けるセッションは最大 5 つです。',

  // Theme Menu
  'theme.section.color': 'カラー',
  'theme.section.shape': 'シェイプ',
  'theme.section.presets': 'プリセット',
  'theme.section.icons': 'アイコン',
  'theme.color.light': 'ライト',
  'theme.color.dark': 'ダーク',
  'theme.color.cappuccino': 'コードダーク',
  'theme.color.sakura': '夜桜',
  'theme.color.lavender': 'ラベンダー',
  'theme.color.mint': 'ミント',
  'theme.preset.cappuccino_slab': 'コードダーク · Slab',
  'theme.preset.sakura_blade': '夜桜 · Blade',
  'theme.preset.mint_sharp': 'ミント · Sharp',
  'theme.preset.lavender_panel': 'ラベンダー · Panel',
  'theme.preset.light_soft': 'ライト · Soft',

  // Gambit · 一手
  'gambit.title': '一手',
  'gambit.placeholder': '静かに一手を思案... (Ctrl+Enterで送信、Enterで改行、画像貼付可)',

  'mode.take_a_break': 'ひと休み',
  'mode.back_to_work': '仕事に戻る',

} as const;
