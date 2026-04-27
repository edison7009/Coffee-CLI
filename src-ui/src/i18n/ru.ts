export const ru = {
  'app.title': 'Coffee CLI',
  'explorer.tab.computer': 'Мой компьютер',
  'explorer.tab.workspace': 'Рабочая область',
  'explorer.workspace.select-dir': 'Нажмите для выбора рабочей папки',

  // Context Menu
  'menu.copy_abs': 'Копировать абсолютный путь',
  'menu.copy_rel': 'Копировать относительный путь',
  'menu.copy_ref': 'Копировать как @reference',
  'menu.cut': 'Вырезать',
  'menu.copy': 'Копировать',
  'menu.paste': 'Вставить',
  'menu.select_all': 'Выбрать всё',
  'menu.rename': 'Переименовать',
  'menu.delete': 'Удалить',
  'menu.show_in_folder': 'Показать в проводнике',

  // Drive kinds (Quick Access)
  'drive.desktop': 'Рабочий стол',
  'drive.downloads': 'Загрузки',
  'drive.documents': 'Документы',
  'drive.pictures': 'Изображения',
  'drive.music': 'Музыка',
  'drive.videos': 'Видео',
  'drive.home': 'Домой',
  'drive.drive': 'Диск {label}',
  'drive.root': 'Корень (/)',
  'drive.volume': '{label}',

  // Tools
  'tool.terminal': 'Терминал',
  'tool.remote': 'Удалённый терминал',
  'tool.remote.short': 'Удалённый',
  'tool.vibeid': 'Тест личности',
  'tool.multi_agent': 'Мульти-агент',
  'tool.two_agent': 'Дуо-агент',
  'tool.three_agent': 'Трио-агент',
  'library.agent_tools': 'Инструменты Agent',
  'sentinel.protocol': 'Протокол Страж',
  'tool.two_split': 'Независимый дуо',
  'tool.three_split': 'Независимый трио',
  'tool.four_split': 'Независимый квадро',
  'vibeid.need_insights_confirm': 'Тест личности сначала требует ваш отчёт об использовании Claude Code.\n\n/insights будет запущен автоматически (около 1-2 минут), затем тест начнётся сам.\n\nПродолжить?',
  'vibeid.insights_timeout': 'Генерация отчёта заняла слишком много времени. Попробуйте позже или запустите /insights вручную во вкладке Claude Code.',

  // Remote Terminal
  'remote.title': 'Удалённый терминал',
  'remote.host': 'Хост',
  'remote.host_placeholder': 'напр. 192.168.1.100',
  'remote.username': 'Имя пользователя',
  'remote.password': 'Пароль',
  'remote.connect': 'Подключиться',
  'remote.connecting': 'Подключение...',
  'remote.connect_failed': 'Ошибка подключения',

  'tab.new': 'Выбрать инструмент',



  // Task Board
  'task.input_placeholder': 'Написать задачу...',
  'task.notes_placeholder': 'Добавить заметки...',
  'task.section.working': 'В работе',
  'task.section.todo': 'К выполнению',
  'task.section.done': 'Завершено',
  'task.greeting.morning': 'Доброе утро, какой план?',
  'task.greeting.afternoon': 'Добрый день, что-то осталось?',
  'task.greeting.evening': 'Добрый вечер. Что-нибудь масштабное?',
  'task.tab.tasks': 'Задачи',
  'task.tab.sessions': 'История',
  'task.default_title': 'Новая задача',
  'task.search_sessions': 'Поиск сессий...',
  'menu.no_recent': 'Нет недавних сессий',
  'task.turns': '{count} ходов',

  // Actions
  'action.close': 'Закрыть',
  'action.resume_terminal': 'Продолжить сессию',

  // Time
  'time.just_now': 'Только что',
  'time.today': 'Сегодня',
  'time.yesterday': 'Вчера',
  'time.days_ago': '{days} дн. назад',

  // Session
  'session.max': 'Можно открывать не более 5 сессий одновременно.',

  // Theme Menu
  'theme.section.color': 'Цвета',
  'theme.section.shape': 'Форма',
  'theme.section.icons': 'Иконки',
  'theme.color.light': 'Светлая',
  'theme.color.dark': 'Тёмная',
  'theme.color.cappuccino': 'Code Dark',
  'theme.color.sakura': 'Сакура',
  'theme.color.lavender': 'Лаванда',
  'theme.color.mint': 'Мята',
  'theme.color.obsidian': 'Обсидиан',
  'theme.color.cobalt': 'Кобальт',
  'theme.color.moss': 'Мох',

  'mode.take_a_break': 'Сделать перерыв',
  'mode.back_to_work': 'Вернуться к работе',

} as const;
