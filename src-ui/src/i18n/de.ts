export const de = {
  'app.title': 'Coffee CLI',
  'explorer.tab.workspace': 'Arbeitsbereich',
  'explorer.tab.history': 'Sitzungen',
  'explorer.workspace.select-dir': 'Klicken zum Arbeitsverzeichnis wählen',

  // Context Menu
  'menu.copy_abs': 'Absoluten Pfad kopieren',
  'menu.copy_rel': 'Relativen Pfad kopieren',
  'menu.copy_ref': 'Als @reference kopieren',
  'menu.cut': 'Ausschneiden',
  'menu.copy': 'Kopieren',
  'menu.paste': 'Einfügen',
  'menu.select_all': 'Alles auswählen',
  'menu.rename': 'Umbenennen',
  'menu.delete': 'Löschen',
  'menu.show_in_folder': 'Im Explorer anzeigen',
  'menu.open': 'Öffnen',


  // Tools
  'tool.terminal': 'Terminal',
  'tool.remote': 'Remote-Terminal',
  'tool.multi_agent': 'Multi-Agent',
  'tool.two_agent': 'Dual-Agent',
  'tool.three_agent': 'Triple-Agent',
  'library.agent_tools': 'Agent-Tools',
  'sentinel.protocol': 'Sentinel-Protokoll',
  'tool.two_split': 'Unabhängiger Dual',
  'tool.three_split': 'Unabhängiger Triple',
  'tool.four_split': 'Unabhängiger Quad',
  'tool.hyper_agent': 'Hyper-Agent',
  'hyper_agent.ready': 'Hyper-Agent gestartet: Dein lokales OpenClaw / Hermes Agent haben jetzt Super-Admin-Rechte, jedes Coffee CLI Fenster einzusehen und zu steuern. Sprich mit OpenClaw / Hermes Agent über deine Social-App — sie werden zu deinem CEO und führen das Agent-Team weiter an die Arbeit.',
  'hyper_agent.first_time_hint': 'Zum ersten Mal hier? Füge die folgende Regel in OpenClaw / Hermes Agent ein, damit sie wissen, wie sie alle laufenden Agents steuern können:',
  'hyper_agent.show_setup_again': 'Setup-Anweisung erneut anzeigen',
  'tool_config.command': 'Startbefehl',
  'tool_config.extra_args': 'Zusätzliche Argumente',
  'tool_config.default_cwd': 'Startverzeichnis',
  'tool_config.history_path': 'Sitzungsverlaufsverzeichnis',
  'tool_config.reset': 'Zurücksetzen',
  'tool_config.cancel': 'Abbrechen',
  'tool_config.save': 'Speichern',

  // Remote Terminal
  'remote.title': 'Remote-Terminal',
  'remote.host': 'Host',
  'remote.host_placeholder': 'z.B. 192.168.1.100',
  'remote.username': 'Benutzername',
  'remote.password': 'Passwort',
  'remote.connect': 'Verbinden',
  'remote.connecting': 'Verbindung wird hergestellt...',
  'remote.connect_failed': 'Verbindung fehlgeschlagen',

  'tab.new': 'Werkzeug wählen',
  'chat.no_records': 'Keine lesbaren Gesprächsaufzeichnungen gefunden.',



  // Task Board
  'task.notes_placeholder': 'Notizen hinzufügen...',
  'task.section.working': 'In Bearbeitung',
  'task.section.todo': 'Offen',
  'task.section.done': 'Erledigt',
  'task.greeting.morning': 'Guten Morgen, was steht an?',
  'task.greeting.afternoon': 'Guten Tag, noch etwas zu tun?',
  'task.greeting.evening': 'Guten Abend. Etwas Großes geplant?',
  'task.tab.tasks': 'Aufgabenliste',
  'task.tab.changes': 'Änderungsverlauf',
  'changes.empty': 'Noch keine Änderungen.',
  'diff.loading': 'Wird geladen…',
  'diff.error': 'Diff konnte nicht geladen werden',
  'diff.no_changes': 'Identisch mit Baseline',
  'task.default_title': 'Neue Aufgabe',
  'task.search_sessions': 'Sitzungen durchsuchen...',
  'menu.no_recent': 'Keine aktuellen Sitzungen',
  'task.messages': '{count} Nachrichten',

  // Actions
  'action.resume_terminal': 'Diese Sitzung fortsetzen',

  // Time
  'time.just_now': 'Gerade eben',
  'time.today': 'Heute',
  'time.yesterday': 'Gestern',
  'time.days_ago': 'Vor {days} Tagen',

  // Session
  'session.max': 'Es können maximal 5 Sitzungen gleichzeitig geöffnet sein.',

  // Theme Menu
  'theme.section.color': 'Farben',
  'theme.section.shape': 'Form',
  'theme.section.icons': 'Icon-Stil',
  'theme.color.light': 'Hell',
  'theme.color.dark': 'Dunkel',
  'theme.color.cappuccino': 'Code Dark',
  'theme.color.sakura': 'Sakura',
  'theme.color.lavender': 'Lavendel',
  'theme.color.mint': 'Minze',
  'theme.color.obsidian': 'Obsidian',
  'theme.color.cobalt': 'Kobalt',
  'theme.color.moss': 'Moos',


  'gambit.send_failed_hint': 'Öffne zuerst eine aktive Sitzung',

  'heatmap.title': '{sessions} Sitzungen · {messages} Nachrichten',
  'heatmap.title_empty': 'Noch nichts los — chatte mit einer KI, um dein erstes Feld zum Leuchten zu bringen',
  'heatmap.legend_less': 'Weniger',
  'heatmap.legend_more': 'Mehr',
  'heatmap.tooltip_some': '{count} Nachrichten am {date}',
  'heatmap.tooltip_one': '1 Nachricht am {date}',
  'heatmap.tooltip_none': 'Keine Aktivität am {date}',

  // Skills-Panel Toggle-Toasts
  'skills.toast.enabled': 'Tool neu starten, damit die Änderung wirksam wird.',
  'skills.toast.disabled': 'Deaktiviert — Tool neu starten, um zu übernehmen.',

} as const;
