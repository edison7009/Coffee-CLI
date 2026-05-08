export const ru = {
  'app.title': 'Coffee CLI',
  'explorer.tab.workspace': 'Рабочая область',
  'explorer.tab.history': 'Сессии',
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
  'menu.open': 'Открыть',


  // Tools
  'tool.terminal': 'Терминал',
  'tool.remote': 'Удалённый терминал',
  'tool.multi_agent': 'Мульти-агент',
  'tool.two_agent': 'Дуо-агент',
  'tool.three_agent': 'Трио-агент',
  'library.agent_tools': 'Инструменты Agent',
  'sentinel.protocol': 'Протокол Страж',
  'tool.two_split': 'Независимый дуо',
  'tool.three_split': 'Независимый трио',
  'tool.four_split': 'Независимый квадро',
  'tool.hyper_agent': 'Hyper-Agent',
  'hyper_agent.ready': 'Hyper-Agent запущен: ваш локальный OpenClaw / Hermes Agent теперь имеет привилегии супер-админа для просмотра и управления каждым окном Coffee CLI. Общайтесь с OpenClaw / Hermes Agent через социальное приложение — они становятся вашим CEO, ведут команду агентов продолжать работать.',
  'hyper_agent.first_time_hint': 'Впервые здесь? Вставьте следующее правило в OpenClaw / Hermes Agent, чтобы они знали, как управлять всеми вашими запущенными Agent\'ами:',
  'hyper_agent.show_setup_again': 'Показать инструкцию снова',
  'tool_config.command': 'Команда запуска',
  'tool_config.extra_args': 'Доп. аргументы',
  'tool_config.default_cwd': 'Каталог запуска',
  'tool_config.history_path': 'Каталог истории диалогов',
  'tool_config.reset': 'Сброс',
  'tool_config.cancel': 'Отмена',
  'tool_config.save': 'Сохранить',

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
  'chat.no_records': 'Читаемые записи разговоров не найдены.',



  // Task Board
  'task.notes_placeholder': 'Добавить заметки...',
  'task.section.working': 'В работе',
  'task.section.todo': 'К выполнению',
  'task.section.done': 'Завершено',
  'task.greeting.morning': 'Доброе утро, какой план?',
  'task.greeting.afternoon': 'Добрый день, что-то осталось?',
  'task.greeting.evening': 'Добрый вечер. Что-нибудь масштабное?',
  'task.tab.tasks': 'Список задач',
  'task.tab.changes': 'История изменений',
  'changes.empty': 'Изменений пока нет.',
  'diff.loading': 'Загрузка…',
  'diff.error': 'Не удалось загрузить diff',
  'diff.no_changes': 'Идентично базовой версии',
  'task.default_title': 'Новая задача',
  'task.search_sessions': 'Поиск сессий...',
  'menu.no_recent': 'Нет недавних сессий',
  'task.messages': '{count} сообщений',

  // Actions
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


  'gambit.send_failed_hint': 'Сначала откройте активную сессию',

  'heatmap.title': 'Сессий: {sessions} · Сообщений: {messages}',
  'heatmap.title_empty': 'История ещё не началась — поговори с ИИ, чтобы зажечь первую клетку',
  'heatmap.legend_less': 'Меньше',
  'heatmap.legend_more': 'Больше',
  'heatmap.tooltip_some': '{date} · {count} сообщений',
  'heatmap.tooltip_one': '{date} · 1 сообщение',
  'heatmap.tooltip_none': '{date} · нет активности',

} as const;
