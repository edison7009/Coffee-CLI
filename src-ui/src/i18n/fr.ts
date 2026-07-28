export const fr = {
  'app.title': 'Coffee CLI',
  'explorer.tab.workspace': 'Espace de travail',
  'explorer.tab.history': 'Sessions',
  'explorer.workspace.select-dir': 'Cliquer pour choisir le dossier de travail',

  // Context Menu
  'menu.copy_abs': 'Copier le chemin absolu',
  'menu.copy_rel': 'Copier le chemin relatif',
  'menu.copy_ref': 'Copier comme @reference',
  'menu.cut': 'Couper',
  'menu.copy': 'Copier',
  'menu.paste': 'Coller',
  'menu.select_all': 'Tout sélectionner',
  'menu.rename': 'Renommer',
  'menu.delete': 'Supprimer',
  'menu.show_in_folder': 'Afficher dans l\u2019explorateur',
  'menu.open': 'Ouvrir',
  'menu.pin': 'Épingler',
  'menu.unpin': 'Désépingler',
  'menu.copy_session_id': 'Copier l’ID de session',
  'menu.copy_resume_command': 'Copier la commande de reprise',
  'menu.copy_full_path': 'Copier le chemin complet',

  // Terminal
  'term.copy_last_reply': 'Copier la dernière réponse',
  'term.copied': 'Copié',
  'term.no_reply': 'Aucune réponse à copier pour le moment',


  // Tools
  'tool.terminal': 'Terminal',
  'tool.remote': 'Terminal distant',
  'library.agent_tools': 'Outils Agent',
  'sentinel.protocol': 'Protocole Sentinelle',
  'tool.two_split': 'Double indépendant',
  'tool.three_split': 'Triple indépendant',
  'tool.four_split': 'Quadruple indépendant',
  'tool_config.command': 'Commande de lancement',
  'tool_config.extra_args': 'Arguments supplémentaires',
  'tool_config.default_cwd': 'Répertoire de lancement',
  'tool_config.history_path': 'Répertoire d\'historique des sessions',
  'tool_config.reset': 'Réinitialiser',
  'tool_config.cancel': 'Annuler',
  'tool_config.save': 'Enregistrer',

  // Remote Terminal
  'remote.title': 'Terminal distant',
  'remote.host': 'Hôte',
  'remote.host_placeholder': 'ex. 192.168.1.100',
  'remote.username': 'Nom d\u2019utilisateur',
  'remote.password': 'Mot de passe',
  'remote.connect': 'Connexion',
  'remote.connecting': 'Connexion en cours...',
  'remote.connect_failed': 'Échec de connexion',

  'tab.new': 'Choisir un outil',


  // Task Board
  'task.notes_placeholder': 'Ajouter des notes...',
  'task.section.working': 'En cours',
  'task.section.todo': 'À faire',
  'task.section.done': 'Terminé',
  'task.greeting.morning': 'Bonjour, quel est le programme ?',
  'task.greeting.afternoon': 'Bon après-midi, encore des choses à faire ?',
  'task.greeting.evening': 'Bonsoir. Un projet ambitieux ?',
  'task.tab.tasks': 'Liste des tâches',
  'task.tab.changes': 'Historique',
  'changes.empty': 'Aucune modification pour le moment.',
  'launchpad.open_folder': 'Ouvrir un dossier',
  'launchpad.detect_help_trigger': "Non détecté ?",
  'launchpad.detect_help_tip': "Si vous avez utilisé un outil terminal d'IA conçu par des développeurs anglophones uniquement, il a pu corrompre les segments de PATH contenant des caractères CJK ou non-ASCII (mojibake), empêchant tout terminal de détecter vos outils. 3 solutions : ① Réinstaller l'outil d'IA ② Corriger le PATH manuellement ③ Laisser l'IA corriger le PATH",
  'launchpad.switch_model_trigger': "Changer de modèle",
  'launchpad.switch_model_tip': "Basculez de modèle en un clic pour tous vos outils d'IA. Nous recommandons EchoBird — cliquez sur « Changer de modèle » pour ouvrir Echobird.ai et le télécharger.",
  'changes.clean': 'Aucune modification — l\'arbre de travail est propre.',
  'changes.no_git': 'Git n\'est pas installé — le diff, les branches et les autres fonctions Git sont indisponibles.',
  'changes.not_repo': 'Ce dossier n\'est pas un dépôt Git.',
  'changes.init_here': 'Initialiser Git ici',
  'changes.initializing': 'Initialisation…',
  'changes.committed': 'Validé',
  'changes.uncommitted': 'Non validé',
  'changes.untracked': 'Non suivi',
  'diff.loading': 'Chargement…',
  'diff.error': 'Échec du chargement du diff',
  'diff.no_changes': 'Aucune modification',
  'diff.too_large': 'Fichier trop volumineux pour afficher le diff',
  'diff.unchanged_lines': '⋯ {count} lignes inchangées',
  'task.default_title': 'Nouvelle tâche',
  'task.search_sessions': 'Rechercher des sessions...',
  'task.filter_all_projects': 'Tous',
  'menu.no_recent': 'Aucune session récente',
  'task.messages': '{count} messages',

  // Actions

  // Time
  'time.just_now': 'À l\u2019instant',
  'time.today': 'Aujourd\u2019hui',
  'time.yesterday': 'Hier',
  'time.days_ago': 'Il y a {days} jours',

  // Settings modal (titlebar gear)
  'settings.title': 'Paramètres',
  'settings.appearance': 'Apparence',
  'settings.wallpaper': "Fond d'écran",
  'settings.terminal': 'Terminal',
  'settings.gambit': 'Raccourcis',
  'settings.language': 'Langue',
  'settings.feedback': 'Bugs et suggestions',
  'settings.feedback.desc': 'Vous avez trouvé un bug ou avez une suggestion ? Cliquez ci-dessous pour soumettre votre problème :',
  'settings.wallpaper.pick': 'Choisir une image ou une vidéo',
  'settings.wallpaper.clear': "Supprimer le fond d'écran",
  'settings.wallpaper.opacity': 'Opacité',
  'settings.terminal.scheme': 'Couleur du texte',
  'settings.terminal.font': 'Police',
  'settings.terminal.font.default': 'Par défaut (incluse)',
  'settings.terminal.shell': 'Shell par défaut',
  'settings.terminal.shell.auto': 'Valeur système',
  'settings.terminal.shell.not_recommended': 'Non recommandé',
  'settings.font.monospace': 'Monospace',
  'settings.font.other': 'Autres polices',
  'settings.font.search': 'Rechercher des polices…',
  'settings.send.title': 'Envoyer le message',
  'settings.send.newline': 'pour un saut de ligne',
  'settings.gambit.hotkey': 'Raccourci clavier',
  'settings.titlebar.toggle': 'Boutons de la barre',
  'settings.titlebar.toggle.icon-hotkey': 'Icône + raccourci',
  'settings.titlebar.toggle.icon': 'Icône seule',
  'settings.titlebar.toggle.hidden': 'Masqué',
  'settings.tasks': 'Tâches',
  'settings.tasks.view': 'Style des tâches',
  'task.view.list': 'Liste de tâches',
  'task.view.note': 'Notes autocollantes',
  'task.view.list.sub': 'Liste compacte, à cocher une par une',
  'task.view.note.sub': 'Grandes notes : écrivez et envoyez tout',
  'task.view.prompt': 'Bibliothèque de prompts',
  'task.view.prompt.sub': 'Catégorisez vos prompts IA, envoyez en un clic',
  'task.prompt.new_category': 'Nouvelle catégorie',
  'task.prompt.category_placeholder': 'Nom de catégorie (choisir ou saisir)',
  'task.prompt.body_placeholder': 'Écrivez un prompt, envoyez-le à l’IA…',
  'task.note_placeholder': 'Notez quelque chose et envoyez le tout à votre agent…',
  'task.welcome_note': `Bienvenue sur Coffee CLI ☕

Ceci est une note autocollante : écrivez ce que vous voulez, puis appuyez sur ▶ (en haut à droite) pour tout envoyer à votre IA. Fini la petite zone de saisie à l'étroit.

Trois étapes pour démarrer :
1. Choisissez un outil au centre (Claude / Codex / OpenCode…), choisissez un dossier, et c'est parti
2. Les trois points définissent la priorité (rouge / ambre / vert) et se trient automatiquement ; tirez le bord inférieur pour redimensionner la note
3. « Historique » (en haut à droite) montre les fichiers touchés par l'IA ; les Réglages contiennent les thèmes, la langue et le choix entre « Liste de tâches » et « Notes autocollantes »

Supprimez cette note quand vous voulez et commencez votre première tâche.`,
  'task.show_guide': "Voir le guide d'utilisation",

  // Theme Menu
  'theme.section.color': 'Couleurs',
  'theme.section.shape': 'Forme',
  'theme.section.icons': 'Icônes',
  'theme.color.light': 'Clair',
  'theme.color.dark': 'Sombre',
  'theme.color.cappuccino': 'Code Dark',
  'theme.color.sakura': 'Sakura',
  'theme.color.lavender': 'Lavande',
  'theme.color.mint': 'Menthe',
  'theme.color.obsidian': 'Obsidienne',
  'theme.color.cobalt': 'Cobalt',
  'theme.color.moss': 'Mousse',
  'theme.color.crimson': 'Cramoisi',
  'theme.color.sunset': 'Couchant',
  'theme.color.amber': 'Ambre',
  'theme.color.emerald': 'Émeraude',
  'theme.color.teal': 'Sarcelle',
  'theme.color.indigo': 'Indigo',
  'theme.color.fuchsia': 'Fuchsia',


  'gambit.send_failed_hint': "Ouvrez d'abord une session active",

  'heatmap.title': '{sessions} sessions · {messages} messages',
  'heatmap.title_empty': 'L\'histoire n\'a pas encore commencé — discutez avec une IA pour allumer votre première case',
  'heatmap.legend_less': 'Moins',
  'heatmap.legend_more': 'Plus',
  'heatmap.tooltip_some': '{count} messages le {date}',
  'heatmap.tooltip_one': '1 message le {date}',
  'heatmap.tooltip_none': 'Aucune activité le {date}',

  // Toasts du panneau Skills
  'skills.toast.enabled': 'Activée',
  'skills.toast.disabled': 'Désactivée',

} as const;
