export const ko = {
  'app.title': 'Coffee CLI',
  'explorer.tab.computer': '내 컴퓨터',
  'explorer.tab.workspace': '작업 공간',
  'explorer.workspace.select-dir': '클릭하여 작업 디렉토리 선택',

  // Context Menu
  'menu.copy_abs': '절대 경로 복사',
  'menu.copy_rel': '상대 경로 복사',
  'menu.copy_ref': '@reference로 복사',
  'menu.cut': '잘라내기',
  'menu.copy': '복사',
  'menu.paste': '붙여넣기',
  'menu.select_all': '모두 선택',
  'menu.rename': '이름 바꾸기',
  'menu.delete': '삭제',
  'menu.show_in_folder': '파일 탐색기에서 열기',

  // Drive kinds (Quick Access)
  'drive.desktop': '바탕화면',
  'drive.downloads': '다운로드',
  'drive.documents': '문서',
  'drive.pictures': '사진',
  'drive.music': '음악',
  'drive.videos': '동영상',
  'drive.home': '홈',
  'drive.drive': '{label} 드라이브',
  'drive.root': '루트 (/)',
  'drive.volume': '{label}',

  // Tools
  'tool.terminal': '터미널',
  'tool.remote': '원격 터미널',
  'tool.remote.short': '원격',
  'tool.vibeid': '성격 테스트',
  'tool.multi_agent': '멀티 에이전트',
  'tool.two_agent': '듀얼 에이전트',
  'tool.three_agent': '트리플 에이전트',
  'library.agent_tools': 'Agent 도구',
  'sentinel.protocol': '센티넬 프로토콜',
  'tool.two_split': '독립 2분할',
  'tool.three_split': '독립 3분할',
  'tool.four_split': '독립 4분할',
  'tool.hyper_agent': 'Hyper-Agent',
  'hyper_agent.ready': 'Hyper-Agent 가 시작되었습니다: 로컬의 OpenClaw / Hermes Agent 는 Coffee CLI 의 모든 창을 조회하고 지휘하는 관리자 권한을 가집니다. 소셜 앱으로 OpenClaw / Hermes Agent 와 대화하면 그들이 당신의 CEO 가 되어 모든 Agent 를 이끌고 계속 작업합니다.',
  'hyper_agent.first_time_hint': '처음 사용하시나요? 아래 규칙을 OpenClaw / Hermes Agent 에 붙여넣어 pane 간 조작 방법을 알려주세요:',
  'hyper_agent.show_setup_again': '설정 안내 다시 표시',
  'vibeid.need_insights_confirm': '성격 테스트를 실행하려면 먼저 Claude Code 사용 기록 리포트가 필요합니다.\n\n/insights를 자동으로 실행합니다 (약 1-2분). 완료 후 성격 테스트가 자동으로 시작됩니다.\n\n계속할까요?',
  'vibeid.insights_timeout': '리포트 생성이 시간 초과되었습니다. 나중에 다시 시도하거나 Claude Code 탭에서 /insights를 수동으로 실행하세요.',

  // Remote Terminal
  'remote.title': '원격 터미널',
  'remote.host': '호스트',
  'remote.host_placeholder': '예: 192.168.1.100',
  'remote.username': '사용자 이름',
  'remote.password': '비밀번호',
  'remote.connect': '연결',
  'remote.connecting': '연결 중...',
  'remote.connect_failed': '연결 실패',

  'tab.new': '도구 선택',


  // Task Board
  'task.input_placeholder': '할 일 입력...',
  'task.notes_placeholder': '메모 추가...',
  'task.section.working': '진행 중',
  'task.section.todo': '할 일',
  'task.section.done': '완료',
  'task.greeting.morning': '좋은 아침, 오늘 계획은?',
  'task.greeting.afternoon': '안녕하세요, 남은 할 일이 있나요?',
  'task.greeting.evening': '좋은 저녁, 뭔가 시작해볼까요?',
  'task.tab.tasks': '작업',
  'task.tab.sessions': '기록',
  'task.default_title': '새 작업',
  'task.search_sessions': '세션 검색...',
  'menu.no_recent': '최근 세션이 없습니다',
  'task.turns': '{count}번 대화',

  // Actions
  'action.close': '닫기',
  'action.resume_terminal': '이 세션 계속하기',

  // Time
  'time.just_now': '방금',
  'time.today': '오늘',
  'time.yesterday': '어제',
  'time.days_ago': '{days}일 전',

  // Session
  'session.max': '동시에 최대 5개의 세션만 열 수 있습니다.',

  // Theme Menu
  'theme.section.color': '색상',
  'theme.section.shape': '형태',
  'theme.section.icons': '아이콘 스타일',
  'theme.color.light': '라이트',
  'theme.color.dark': '다크',
  'theme.color.cappuccino': '코드 다크',
  'theme.color.sakura': '사쿠라',
  'theme.color.lavender': '라벤더',
  'theme.color.mint': '민트',
  'theme.color.obsidian': '옵시디언',
  'theme.color.cobalt': '코발트',
  'theme.color.moss': '이끼',

  // Gambit · 한 수
  'gambit.title': '한 수',
  'gambit.placeholder': '한 수를 고르는 중... (Ctrl+Enter 전송, Enter 줄바꿈, 이미지 붙여넣기)',
  'gambit.send_failed_hint': 'pane 을 먼저 클릭한 뒤 전송',
  'gambit.send_empty_hint': '내용을 입력하거나 이미지를 붙여넣으세요 (Ctrl+V)',
  'gambit.ctx_cut': '잘라내기',
  'gambit.ctx_copy': '복사',
  'gambit.ctx_paste': '붙여넣기',
  'gambit.ctx_select_all': '전체 선택',

  'mode.take_a_break': '잠깐 쉬기',
  'mode.back_to_work': '업무로 복귀',

} as const;
