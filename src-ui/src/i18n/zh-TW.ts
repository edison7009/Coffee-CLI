export const zhTW = {
  'app.title': 'Coffee CLI',
  'explorer.tab.computer': '我的電腦',
  'explorer.tab.workspace': '工作區',
  'explorer.workspace.select-dir': '點擊選擇工作目錄',

  // Context Menu
  'menu.copy_abs': '複製絕對路徑',
  'menu.copy_rel': '複製相對路徑',
  'menu.copy_ref': '複製為 @reference',
  'menu.cut': '剪下',
  'menu.copy': '複製',
  'menu.paste': '貼上',
  'menu.select_all': '全選',
  'menu.rename': '重新命名',
  'menu.delete': '刪除',
  'menu.show_in_folder': '在檔案總管中顯示',

  // Drive kinds (Quick Access)
  'drive.desktop': '桌面',
  'drive.downloads': '下載',
  'drive.documents': '文件',
  'drive.pictures': '圖片',
  'drive.music': '音樂',
  'drive.videos': '影片',
  'drive.home': '主目錄',
  'drive.drive': '{label} 磁碟',
  'drive.root': '根目錄 (/)',
  'drive.volume': '{label}',

  // Tools
  'tool.terminal': '終端機',
  'tool.remote': '遠端終端機',
  'tool.remote.short': '遠端',
  'tool.installer': '一鍵安裝',
  'tool.vibeid': '人格測試',
  'tool.insights_prerun': '正在生成使用報告...',
  'tool.multi_agent': '多智能體',
  'vibeid.need_insights_confirm': '人格測試需要先生成你的 Claude Code 使用報告。\n\n將自動執行 /insights（約 1-2 分鐘），完成後自動跑人格測試。\n\n繼續？',
  'vibeid.insights_timeout': '報告生成逾時。請稍後重試，或在 Claude Code tab 裡手動跑 /insights。',

  // Remote Terminal
  'remote.title': '遠端終端機',
  'remote.host': '伺服器位址',
  'remote.host_placeholder': '例如 192.168.1.100',
  'remote.username': '使用者名稱',
  'remote.password': '密碼',
  'remote.connect': '連線',
  'remote.connecting': '連線中...',
  'remote.connect_failed': '連線失敗',

  'tab.new': '選擇工具',


  // Task Board
  'task.input_placeholder': '寫下一個任務...',
  'task.notes_placeholder': '新增備註...',
  'task.section.working': '進行中',
  'task.section.todo': '待辦',
  'task.section.done': '已完成',
  'task.greeting.morning': '早安，今天想做些什麼？',
  'task.greeting.afternoon': '午安，還有什麼要做的？',
  'task.greeting.evening': '晚安，想來點大事嗎？',
  'task.tab.tasks': '任務',
  'task.tab.sessions': '歷史',
  'task.default_title': '新任務',
  'task.search_sessions': '搜尋歷史對話...',
  'menu.no_recent': '沒有任何近期對話',
  'task.turns': '{count} 輪對話',

  // Actions
  'action.close': '關閉',
  'action.resume_terminal': '繼續此次對話',

  // Time
  'time.just_now': '剛剛',
  'time.today': '今天',
  'time.yesterday': '昨天',
  'time.days_ago': '{days} 天前',

  // Session
  'session.max': '最多只能同時開啟 5 個會話。',

  // Theme Menu
  'theme.section.color': '配色',
  'theme.section.shape': '形態',
  'theme.section.icons': '圖示風格',
  'theme.color.light': '明亮',
  'theme.color.dark': '暗黑',
  'theme.color.cappuccino': '代碼夜',
  'theme.color.sakura': '夜櫻',
  'theme.color.lavender': '薰衣草霧',
  'theme.color.mint': '薄荷深海',
  'theme.color.obsidian': '黑曜石',
  'theme.color.cobalt': '鈷藍',
  'theme.color.moss': '苔蘚',

  // Gambit · 妙手
  'gambit.title': '妙手',
  'gambit.placeholder': '靜心琢磨，再落子... (Ctrl+Enter 發送, Enter 換行, 可貼上圖片)',

  'mode.take_a_break': '放鬆一下',
  'mode.back_to_work': '回到工作',

} as const;
