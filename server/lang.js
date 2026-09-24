// ============================================================
// 비서 문구 — 한국어 · 영어 (specs/007-people-and-languages)
//   사람마다 고른 언어로 답한다. 키가 없으면 한국어로, 그것도 없으면 키 이름을 그대로 쓴다.
//   (영상 내레이션 다국어는 i18n.js — 여기는 비서·텔레그램·템플릿 문구)
// ============================================================
export const LANGS = ['ko', 'en'];
export const normLang = (l) => (LANGS.includes(l) ? l : 'ko');

const M = {
  ko: {
    help: '이렇게 말해 보세요:\n• "매일 8시 30분에 약 먹으라고 알려줘"\n• "평일 아침 8시에 브리핑 보내줘"\n• "https://… 바뀌면 알려줘"\n• "전에 읽은 결제일 뭐였지?"\n• "템플릿 보여줘" · "내 자동화 목록" · "요즘 뭐 했어?"\n• "○○ 자동화 돌려줘"\n• 사진이나 긴 글을 보내면 읽고 답해요',
    unknown: '잘 모르겠어요.\n{help}',
    templatesHead: '골라서 쓸 수 있는 비서:',
    listHead: '내 자동화:',
    listEmpty: '아직 자동화가 없어요. "템플릿 보여줘" 라고 해 보세요.',
    statusHead: '최근 실행:',
    statusEmpty: '아직 실행한 게 없어요.',
    recallNone: '기억에서 찾지 못했어요. (읽은 적이 없거나, 관련이 확실하지 않아서 억지로 붙이지 않았어요)',
    recallHead: '기억에서 찾았어요 (원문 그대로):',
    noTemplate: '그런 비서 템플릿은 없어요.',
    cantCreate: '이렇게는 만들 수 없어요: {errors}',
    askCreate: '{icon} {what} — 만들까요?',
    btnCreate: '✅ 만들기', btnRun: '✅ 실행', btnCancel: '취소',
    wfNotFound: '"{name}" 자동화를 찾지 못했어요. "내 자동화 목록" 이라고 하면 이름을 볼 수 있어요.',
    askRunSide: '"{name}" 은 밖으로 내보내는 동작(메시지·업로드 등)이 있어요. 실행할까요?',
    ran: '{mark} "{name}" 실행 — {status}',
    made: '✅ 만들었어요: {name}{when}',
    madeWhen: '\n{when}에 알려 드릴게요.',
    cancelled: '취소했어요.', already: '이미 처리했어요.', noRequest: '없는 요청이에요.', notYours: '다른 사람의 요청이라 누를 수 없어요.',
    cantMake: '만들지 못했어요: {errors}', wfGone: '자동화가 없어졌어요.',
    // 텔레그램
    notConnected: '안녕하세요! 이 채팅은 아직 연결되지 않았어요.\nPC 의 conduit "쉬운 시작" 화면에서 [허용] 을 누르면 연결됩니다.\n\nHi! This chat isn\'t connected yet. Ask the PC owner to press [Allow] in conduit.',
    connected: '연결되어 있어요 ✅\n{status}\n\n사진이나 글을 보내면 PC 가 읽어요. /mode 로 받기·보내기를, /me 로 내 정보를 바꿀 수 있어요.',
    modeAsk: '어떻게 주고받을까요?', modeNow: '모드: {mode}', modeChanged: '{mode} 로 바꿨어요',
    commands: '쓸 수 있는 명령: /mode · /status · /me · 또는 그냥 말로 (예: "매일 8시에 약 먹으라고 알려줘")',
    tgOff: '지금은 텔레그램이 꺼져 있어요. /mode 로 켤 수 있어요.',
    notReceiving: '지금은 받지 않아요 (모드: {mode}).\n/mode 로 바꿀 수 있어요.',
    noInbox: '받은 것을 넣을 곳이 없어요. PC 의 "쉬운 시작" 화면에서 [시작 준비] 를 눌러 주세요.',
    onlyPhotoText: '사진이나 글만 받을 수 있어요.', gotFail: '받지 못했어요: {error}',
    gotReply: '받았어요 📥 읽고 나서 알려 드릴게요.', gotNoReply: '받았어요 📥 (보내기가 꺼져 있어 결과는 PC 에서만 볼 수 있어요)',
    statusMode: '모드: {mode}', statusInbox: '받은 것을 넣는 곳: {inbox}', statusInboxNone: '(없음 — 화면의 쉬운 시작에서 준비하세요)',
    statusBeat: '마지막 자동 확인: {beat}', none: '(없음)',
    // 결과 답장
    readHead: '📖 읽은 내용', readNoSentence: '• 근거가 확인된 문장이 없어요', notInDoc: '❓ 문서에 없던 것: {list}',
    readStats: '검증 {v}/{q} · 근거율 {g}', linkedMem: ' · 전에 읽은 것 {n}건과 연결',
    skipped: '읽기를 건너뛰었어요: {note}', noKey: 'Claude 키가 없어요', handled: '처리했어요 ({status})',
    waitApproval: '⏸ 다음 단계는 승인을 기다려요.', hadError: '⚠️ 처리 중 오류가 있었어요. PC 의 실행 기록을 확인해 주세요.',
    failNotice: '⚠️ 자동화 실패: {name}\n{err}\nPC 의 실행 기록에서 자세히 볼 수 있어요.', doneNotice: '✅ {name} 완료',
    // 처음 연결 — 내 정보
    obLang: '어떤 언어로 도와드릴까요?\nWhich language should I use?',
    obName: '반가워요! 뭐라고 불러 드릴까요? (이름이나 별명)',
    obWake: '{name}님, 보통 몇 시에 일어나세요? (예: 7시, 06:30) — 모르면 "건너뛰기"',
    obInterests: '관심 있는 주제를 쉼표로 알려 주세요. (예: 경제, 축구, AI) — 없으면 "없음"',
    obDone: '준비됐어요, {name}님! 🎉\n{help}',
    obBadTime: '시각을 못 알아들었어요. "7시" 나 "06:30" 처럼 보내 주세요. (건너뛰려면 "건너뛰기")',
    greet: '{name}님, ',
  },
  en: {
    help: 'Try saying:\n• "remind me to take my medicine every day at 8:30"\n• "send me a morning brief on weekdays at 8"\n• "tell me when https://… changes"\n• "what was the payment date I read earlier?"\n• "show templates" · "list my automations" · "what did you do lately?"\n• "run the order workflow"\n• Send a photo or a long text and I\'ll read it',
    unknown: 'Sorry, I didn\'t get that.\n{help}',
    templatesHead: 'Assistants you can pick:',
    listHead: 'Your automations:',
    listEmpty: 'No automations yet. Try "show templates".',
    statusHead: 'Recent runs:',
    statusEmpty: 'Nothing has run yet.',
    recallNone: 'I couldn\'t find that in memory. (Either you never read it, or nothing was clearly related — I won\'t force a match.)',
    recallHead: 'Found in memory (verbatim):',
    noTemplate: 'There\'s no such template.',
    cantCreate: 'I can\'t create that: {errors}',
    askCreate: '{icon} {what} — create it?',
    btnCreate: '✅ Create', btnRun: '✅ Run', btnCancel: 'Cancel',
    wfNotFound: 'I couldn\'t find the automation "{name}". Say "list my automations" to see the names.',
    askRunSide: '"{name}" sends things out (messages, uploads…). Run it?',
    ran: '{mark} Ran "{name}" — {status}',
    made: '✅ Created: {name}{when}',
    madeWhen: '\nI\'ll let you know {when}.',
    cancelled: 'Cancelled.', already: 'Already done.', noRequest: 'No such request.', notYours: 'That request belongs to someone else.',
    cantMake: 'Couldn\'t create it: {errors}', wfGone: 'That automation no longer exists.',
    notConnected: 'Hi! This chat isn\'t connected yet. Ask the PC owner to press [Allow] in conduit ("Easy start").\n\n안녕하세요! 이 채팅은 아직 연결되지 않았어요.',
    connected: 'You\'re connected ✅\n{status}\n\nSend a photo or text and the PC will read it. Use /mode to choose directions and /me to change your profile.',
    modeAsk: 'How should we send things?', modeNow: 'Mode: {mode}', modeChanged: 'Switched to {mode}',
    commands: 'Commands: /mode · /status · /me · or just talk to me (e.g. "remind me to drink water at 8")',
    tgOff: 'Telegram is turned off right now. Use /mode to turn it on.',
    notReceiving: 'I\'m not receiving right now (mode: {mode}).\nUse /mode to change it.',
    noInbox: 'There\'s nowhere to put it yet. Press [Get started] in conduit\'s "Easy start" on the PC.',
    onlyPhotoText: 'I can only take photos or text.', gotFail: 'Couldn\'t receive it: {error}',
    gotReply: 'Got it 📥 I\'ll reply after reading.', gotNoReply: 'Got it 📥 (sending is off, so results stay on the PC)',
    statusMode: 'Mode: {mode}', statusInbox: 'Inbox for: {inbox}', statusInboxNone: '(none — set it up in Easy start)',
    statusBeat: 'Last auto-check: {beat}', none: '(none)',
    readHead: '📖 What I read', readNoSentence: '• No sentence could be verified', notInDoc: '❓ Not in the document: {list}',
    readStats: 'verified {v}/{q} · grounded {g}', linkedMem: ' · linked to {n} earlier item(s)',
    skipped: 'Skipped reading: {note}', noKey: 'no Claude key', handled: 'Done ({status})',
    waitApproval: '⏸ The next step is waiting for approval.', hadError: '⚠️ Something went wrong. Check the run history on the PC.',
    failNotice: '⚠️ Automation failed: {name}\n{err}\nSee the run history on the PC for details.', doneNotice: '✅ {name} finished',
    obLang: '어떤 언어로 도와드릴까요?\nWhich language should I use?',
    obName: 'Nice to meet you! What should I call you?',
    obWake: 'What time do you usually wake up, {name}? (e.g. 7am, 06:30) — or "skip"',
    obInterests: 'What topics are you into? Comma-separated (e.g. economy, football, AI) — or "none"',
    obDone: 'All set, {name}! 🎉\n{help}',
    obBadTime: 'I didn\'t catch the time. Send something like "7am" or "06:30" (or "skip").',
    greet: '{name}, ',
  },
};

export function t(lang, key, vars = {}) {
  const s = M[normLang(lang)][key] ?? M.ko[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_m, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
}

// 템플릿 선택값은 안에서는 한국어 값 그대로 쓰고, 보여 줄 때만 옮긴다
export const OPTION_EN = {
  매일: 'Every day', 평일: 'Weekdays', 주말: 'Weekends', 월요일: 'Mondays', 금요일: 'Fridays',
  '10분마다': 'Every 10 min', '1시간마다': 'Hourly', '매일 아침 9시': 'Daily at 9 AM',
};
export const optionLabel = (v, lang) => (normLang(lang) === 'en' ? OPTION_EN[v] || v : v);

// 모드 이름
export const MODE_LABEL = {
  ko: { both: '둘 다 (휴대폰 ↔ PC)', inbound: '받기만 (휴대폰 → PC)', outbound: '보내기만 (PC → 휴대폰)', off: '끄기' },
  en: { both: 'Both (phone ↔ PC)', inbound: 'Receive only (phone → PC)', outbound: 'Send only (PC → phone)', off: 'Off' },
};
