export const es = {
  'app.title': 'Coffee CLI',
  'explorer.tab.computer': 'Mi PC',
  'explorer.tab.workspace': 'Espacio de trabajo',
  'explorer.workspace.select-dir': 'Clic para seleccionar directorio de trabajo',

  // Context Menu
  'menu.copy_abs': 'Copiar ruta absoluta',
  'menu.copy_rel': 'Copiar ruta relativa',
  'menu.copy_ref': 'Copiar como @reference',
  'menu.cut': 'Cortar',
  'menu.copy': 'Copiar',
  'menu.paste': 'Pegar',
  'menu.select_all': 'Seleccionar todo',
  'menu.rename': 'Renombrar',
  'menu.delete': 'Eliminar',
  'menu.show_in_folder': 'Mostrar en el explorador',

  // Drive kinds (Quick Access)
  'drive.desktop': 'Escritorio',
  'drive.downloads': 'Descargas',
  'drive.documents': 'Documentos',
  'drive.pictures': 'Imágenes',
  'drive.music': 'Música',
  'drive.videos': 'Vídeos',
  'drive.home': 'Inicio',
  'drive.drive': 'Unidad {label}',
  'drive.root': 'Raíz (/)',
  'drive.volume': '{label}',

  // Tools
  'tool.terminal': 'Terminal',
  'tool.remote': 'Terminal remoto',
  'tool.remote.short': 'Remoto',
  'tool.installer': 'Instalador',
  'tool.vibeid': 'Test de personalidad',
  'tool.insights_prerun': 'Generando informe de uso...',
  'tool.multi_agent': 'Multi-Agente',
  'tool.two_split': 'Doble Independiente',
  'tool.three_split': 'Triple Independiente',
  'tool.four_split': 'Cuádruple Independiente',
  'vibeid.need_insights_confirm': 'El Test de personalidad necesita primero tu informe de uso de Claude Code.\n\n/insights se ejecutará automáticamente (aproximadamente 1-2 minutos), luego el test comenzará solo.\n\n¿Continuar?',
  'vibeid.insights_timeout': 'La generación del informe tardó demasiado. Inténtalo más tarde o ejecuta /insights manualmente en una pestaña de Claude Code.',

  // Remote Terminal
  'remote.title': 'Terminal remoto',
  'remote.host': 'Host',
  'remote.host_placeholder': 'ej. 192.168.1.100',
  'remote.username': 'Usuario',
  'remote.password': 'Contraseña',
  'remote.connect': 'Conectar',
  'remote.connecting': 'Conectando...',
  'remote.connect_failed': 'Error de conexión',

  'tab.new': 'Seleccionar herramienta',


  // Task Board
  'task.input_placeholder': 'Escribir una tarea...',
  'task.notes_placeholder': 'Agregar notas...',
  'task.section.working': 'En progreso',
  'task.section.todo': 'Pendiente',
  'task.section.done': 'Completado',
  'task.greeting.morning': 'Buenos días, ¿cuál es el plan?',
  'task.greeting.afternoon': 'Buenas tardes, ¿algo pendiente?',
  'task.greeting.evening': 'Buenas noches, ¿algo ambicioso?',
  'task.tab.tasks': 'Tareas',
  'task.tab.sessions': 'Historial',
  'task.default_title': 'Nueva tarea',
  'task.search_sessions': 'Buscar sesiones...',
  'menu.no_recent': 'No hay sesiones recientes',
  'task.turns': '{count} turnos',

  // Actions
  'action.close': 'Cerrar',
  'action.resume_terminal': 'Continuar esta sesión',

  // Time
  'time.just_now': 'Ahora mismo',
  'time.today': 'Hoy',
  'time.yesterday': 'Ayer',
  'time.days_ago': 'Hace {days} días',

  // Session
  'session.max': 'Se pueden abrir un máximo de 5 sesiones a la vez.',

  // Theme Menu
  'theme.section.color': 'Colores',
  'theme.section.shape': 'Forma',
  'theme.section.icons': 'Iconos',
  'theme.color.light': 'Claro',
  'theme.color.dark': 'Oscuro',
  'theme.color.cappuccino': 'Code Dark',
  'theme.color.sakura': 'Sakura',
  'theme.color.lavender': 'Lavanda',
  'theme.color.mint': 'Menta',
  'theme.color.obsidian': 'Obsidiana',
  'theme.color.cobalt': 'Cobalto',
  'theme.color.moss': 'Musgo',

  'mode.take_a_break': 'Tomar un descanso',
  'mode.back_to_work': 'Volver al trabajo',

} as const;
