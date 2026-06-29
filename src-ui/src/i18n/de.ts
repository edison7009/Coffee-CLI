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
  'library.agent_tools': 'Agent-Tools',
  'sentinel.protocol': 'Sentinel-Protokoll',
  'tool.two_split': 'Unabhängiger Dual',
  'tool.three_split': 'Unabhängiger Triple',
  'tool.four_split': 'Unabhängiger Quad',
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
  'launchpad.open_folder': 'Ordner öffnen',
  'changes.clean': 'Keine Änderungen — Arbeitsverzeichnis ist sauber.',
  'changes.no_git': 'Git ist nicht installiert — Code-Diff, Branches und andere Git-Funktionen sind nicht verfügbar.',
  'changes.not_repo': 'Dieser Ordner ist kein Git-Repository.',
  'changes.init_here': 'Git hier initialisieren',
  'changes.initializing': 'Initialisierung…',
  'changes.staged': 'Bereitgestellt',
  'changes.unstaged': 'Nicht bereitgestellt',
  'changes.untracked': 'Unverfolgt',
  'diff.loading': 'Wird geladen…',
  'diff.error': 'Diff konnte nicht geladen werden',
  'diff.no_changes': 'Keine Änderungen',
  'diff.too_large': 'Datei zu groß für die Inline-Diff-Ansicht',
  'diff.unchanged_lines': '⋯ {count} unveränderte Zeilen',
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

  // Settings modal (titlebar gear)
  'settings.title': 'Einstellungen',
  'settings.appearance': 'Darstellung',
  'settings.wallpaper': 'Hintergrund',
  'settings.terminal': 'Terminal',
  'settings.gambit': 'Gambit',
  'settings.language': 'Sprache',
  'settings.wallpaper.pick': 'Bild oder Video wählen',
  'settings.wallpaper.clear': 'Hintergrund entfernen',
  'settings.wallpaper.opacity': 'Deckkraft',
  'settings.terminal.scheme': 'Textfarbe',
  'settings.send.title': 'Nachricht senden',
  'settings.send.newline': 'für neue Zeile',
  'settings.gambit.hotkey': 'Kürzel zum Umschalten',
  'settings.tasks': 'Aufgaben',
  'settings.tasks.view': 'Aufgaben-Stil',
  'task.view.list': 'To-do-Liste',
  'task.view.note': 'Notizzettel',
  'task.view.list.sub': 'Kompakte Liste, einzeln abhaken',
  'task.view.note.sub': 'Große Zettel – frei schreiben, alles senden',
  'task.note_placeholder': 'Schreib etwas auf und sende alles an deinen Agenten…',
  'task.welcome_note': `Willkommen bei Coffee CLI ☕

Das ist ein Notizzettel: Schreib einfach drauflos und tippe oben rechts auf ▶, um alles an deine KI zu schicken. Schluss mit dem engen kleinen Eingabefeld.

In drei Schritten loslegen:
1. Wähl in der Mitte ein Werkzeug (Claude / Codex / OpenCode…), wähl einen Ordner – und schon läuft es
2. Die drei Punkte setzen die Priorität (rot / gelb / grün) und sortieren automatisch; zieh an der Unterkante, um den Zettel größer oder kleiner zu machen
3. „Änderungsverlauf" (oben rechts) zeigt, welche Dateien die KI angefasst hat; in den Einstellungen gibt es Designs, Sprache und den Wechsel zwischen „To-do-Liste" und „Notizzettel"

Lösch diesen Zettel, wann du willst, und starte deine erste Aufgabe.`,
  'task.show_guide': 'Anleitung ansehen',

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
  'theme.color.crimson': 'Karmesin',
  'theme.color.sunset': 'Abendrot',
  'theme.color.amber': 'Bernstein',
  'theme.color.emerald': 'Smaragd',
  'theme.color.teal': 'Petrol',
  'theme.color.indigo': 'Indigo',
  'theme.color.fuchsia': 'Fuchsia',


  'gambit.send_failed_hint': 'Öffne zuerst eine aktive Sitzung',

  'heatmap.title': '{sessions} Sitzungen · {messages} Nachrichten',
  'heatmap.title_empty': 'Noch nichts los — chatte mit einer KI, um dein erstes Feld zum Leuchten zu bringen',
  'heatmap.legend_less': 'Weniger',
  'heatmap.legend_more': 'Mehr',
  'heatmap.tooltip_some': '{count} Nachrichten am {date}',
  'heatmap.tooltip_one': '1 Nachricht am {date}',
  'heatmap.tooltip_none': 'Keine Aktivität am {date}',

  // Skills-Panel Toggle-Toasts
  'skills.toast.enabled': 'Aktiviert',
  'skills.toast.disabled': 'Deaktiviert',

} as const;
