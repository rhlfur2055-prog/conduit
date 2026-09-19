// ============================================================
// 다국어 내레이션 · 음성 · 유튜브 메타데이터
//   화면 문구는 video-pipeline/src/i18n.ts, 여기는 "소리와 메타데이터" 담당.
//   음성 이름은 msedge-tts getVoices()로 실존 확인함 (2026-08-13).
//   ⚠️ 수치는 검증된 논문 값만 쓴다 (no-fake-stats 정책).
//      - 무주의 맹시: 192명 중 46%가 못 봄 — Simons & Chabris, Perception 1999
//      - 한국 색각이상: 남 6.5% / 여 1.1% — Kim & Ng, Optom Vis Sci 2019
// ============================================================

export const LOCALES = ['ko', 'en', 'ja', 'es'];

/** 로케일별 기본 내레이션 음성 (남성 톤으로 통일 — 기존 한국어 채널과 일관) */
export const TTS_VOICE = {
  ko: 'ko-KR-InJoonNeural',
  en: 'en-US-AndrewNeural',
  ja: 'ja-JP-KeitaNeural',
  es: 'es-MX-JorgeNeural',
};

/** 유튜브 업로드용 언어 코드 (defaultLanguage / localizations 키) */
export const YT_LANG = { ko: 'ko', en: 'en', ja: 'ja', es: 'es' };

const pick = (obj, locale) => obj[locale] || obj.ko;

/* ============================================================
   색각 (숨은 숫자)
   ============================================================ */
const CV_ORD = {
  ko: ['첫 번째', '두 번째', '세 번째', '네 번째', '다섯 번째'],
  en: ['First', 'Second', 'Third', 'Fourth', 'Fifth'],
  ja: ['一枚目', '二枚目', '三枚目', '四枚目', '五枚目'],
  es: ['Primera', 'Segunda', 'Tercera', 'Cuarta', 'Quinta'],
};

const CV = {
  ko: {
    intro: '지금부터 색각 테스트를 시작합니다. 원판 속에 숨은 숫자를 찾아보세요.',
    diff: { easy: '몸풀기입니다.', mid: '조금 어렵습니다.', hard: '이번이 제일 어렵습니다.' },
    q: (ord, diff) => `${ord} 판. ${diff} 어떤 숫자가 보이시나요? 시간은 삼 초입니다.`,
    a: (n) => `정답은, ${n}!`,
    ending: '몇 개 보셨나요? 한국 성인 색각이상은 남성 여섯 점 오 퍼센트, 여성 일 점 일 퍼센트로 보고돼 있습니다. 안 보였다고 걱정 마시고, 결과를 댓글로 알려주세요.',
  },
  en: {
    intro: 'Time for a color vision test. Find the number hidden in each circle.',
    diff: { easy: 'A warm-up.', mid: 'A bit harder.', hard: 'This one is the hardest.' },
    q: (ord, diff) => `${ord} plate. ${diff} What number do you see? You have three seconds.`,
    a: (n) => `The answer is ${n}!`,
    ending: 'How many did you get? Studies report color vision deficiency in about eight percent of men of European descent. If you missed one, do not worry. Tell us your score in the comments.',
  },
  ja: {
    intro: '色覚テストを始めます。円の中に隠れた数字を探してください。',
    diff: { easy: 'ウォーミングアップです。', mid: '少し難しくなります。', hard: '今回が一番難しいです。' },
    q: (ord, diff) => `${ord}。${diff} どの数字が見えますか？制限時間は三秒です。`,
    a: (n) => `正解は、${n}！`,
    ending: '何個見えましたか？色覚特性は日本人男性のおよそ五パーセントとされています。見えなくても心配いりません。結果をコメントで教えてください。',
  },
  es: {
    intro: 'Empezamos el test de visión del color. Encuentra el número escondido en cada círculo.',
    diff: { easy: 'Para calentar.', mid: 'Un poco más difícil.', hard: 'Esta es la más difícil.' },
    q: (ord, diff) => `Lámina ${ord}. ${diff} ¿Qué número ves? Tienes tres segundos.`,
    a: (n) => `¡La respuesta es ${n}!`,
    ending: '¿Cuántos viste? Los estudios reportan deficiencia de visión del color en cerca del ocho por ciento de los hombres de ascendencia europea. Si fallaste una, no te preocupes. Cuéntanos tu resultado en los comentarios.',
  },
};

/* 컴팩트(15~20초) 대본 — 인트로 없이 첫 프레임부터 문제, 엔딩 한 줄.
   레퍼런스 채널(뇌글링) 평균 16초에 맞추기 위한 변형. */
const CV_SHORT = {
  ko: { q: '이 안에 숫자, 보이나요?', a: (n) => `정답은 ${n}!`, ending: '보였으면 좋아요, 안 보였으면 댓글!' },
  en: { q: 'Can you see the number?', a: (n) => `It's ${n}!`, ending: 'Saw it? Like. Missed it? Comment!' },
  ja: { q: 'この中の数字、見えますか？', a: (n) => `正解は${n}！`, ending: '見えたら高評価、見えなかったらコメント！' },
  es: { q: '¿Ves el número?', a: (n) => `¡Es el ${n}!`, ending: '¿Lo viste? Dale like. ¿No? ¡Comenta!' },
};

/** 색각 내레이션 — plate.qText/aText 로 개별 덮어쓰기 가능
 *  @param {boolean} [compact] 15~20초용 짧은 대본 (인트로 생략) */
export function cvNarration(plates, locale = 'ko', compact = false) {
  const T = pick(CV, locale);
  const ord = pick(CV_ORD, locale);
  if (compact) {
    const S = pick(CV_SHORT, locale);
    return {
      intro: '',                                   // 빈 문자열 = 인트로 세그먼트 생략
      rounds: plates.map((p) => ({ q: p.qText || S.q, a: p.aText || S.a(p.number) })),
      ending: S.ending,
    };
  }
  return {
    intro: T.intro,
    rounds: plates.map((p, i) => ({
      q: p.qText || T.q(ord[i] || String(i + 1), T.diff[p.palette] || ''),
      a: p.aText || T.a(p.number),
    })),
    ending: T.ending,
  };
}

/* ============================================================
   집중력 (공 세기 + 숨은 고양이)
   ============================================================ */
const AT = {
  ko: {
    intro: '빨간 공이 벽에 몇 번 튕기는지 세어보세요! 셋, 둘, 하나, 시작!',
    q1: '자, 빨간 공은 과연 몇 번 튕겼을까요?',
    a1: (n) => `정답은, ${n}번입니다! 맞히셨나요?`,
    q2: '그런데... 혹시, 까만 고양이가 지나간 거 보셨나요?',
    a2: '못 봤다면, 처음부터 다시 돌려보세요!',
    ending: '못 보셨어도 정상입니다. 원조 실험에서는 참가자 백구십이 명 중 사십육 퍼센트가 지나가는 대상을 알아차리지 못했습니다. 결과를 댓글로 알려주세요!',
  },
  en: {
    intro: 'Count how many times the red ball hits a wall! Three, two, one, go!',
    q1: 'So, how many times did the red ball bounce?',
    a1: (n) => `The answer is ${n}! Did you get it?`,
    q2: 'But wait. Did you notice the black cat walk across the screen?',
    a2: 'If you missed it, play it again from the start!',
    ending: 'Missing it is completely normal. In the original experiment, forty six percent of one hundred ninety two participants failed to notice it. Tell us your result in the comments!',
  },
  ja: {
    intro: '赤いボールが壁に何回はねるか数えてください！さん、に、いち、スタート！',
    q1: 'さて、赤いボールは何回はねたでしょうか？',
    a1: (n) => `正解は、${n}回です！当たりましたか？`,
    q2: 'ところで... 黒いネコが通ったのに気づきましたか？',
    a2: '見逃した人は、最初からもう一度見てください！',
    ending: '見逃しても正常です。元の実験では、参加者百九十二人のうち四十六パーセントが気づきませんでした。結果をコメントで教えてください！',
  },
  es: {
    intro: '¡Cuenta cuántas veces rebota la pelota roja contra las paredes! Tres, dos, uno, ¡ya!',
    q1: 'Entonces, ¿cuántas veces rebotó la pelota roja?',
    a1: (n) => `¡La respuesta es ${n}! ¿Acertaste?`,
    q2: 'Pero espera. ¿Viste pasar al gato negro por la pantalla?',
    a2: '¡Si no lo viste, míralo otra vez desde el principio!',
    ending: 'No verlo es completamente normal. En el experimento original, el cuarenta y seis por ciento de ciento noventa y dos participantes no lo notó. ¡Cuéntanos tu resultado en los comentarios!',
  },
};

export function atNarration(answer, locale = 'ko') {
  const T = pick(AT, locale);
  return { intro: T.intro, q1: T.q1, a1: T.a1(answer), q2: T.q2, a2: T.a2, ending: T.ending };
}

/* ============================================================
   트록슬러 사라짐 — 해외 겨냥(화면에 글자가 거의 없어도 성립)
   ============================================================ */
const TX = {
  ko: {
    intro: '가운데 빨간 점만 보세요. 눈을 움직이면 안 됩니다.',
    reveal: '주변 색이 사라졌나요? 화면은 처음부터 하나도 바뀌지 않았습니다.',
    ending: '지운 건 화면이 아니라 당신의 뇌입니다. 트록슬러 효과라고 해요.',
  },
  en: {
    intro: 'Stare at the red dot in the center. Do not move your eyes.',
    reveal: 'Did the colors fade away? The screen never changed, not even once.',
    ending: 'Your brain erased them, not the screen. This is the Troxler effect.',
  },
  ja: {
    intro: '真ん中の赤い点だけを見てください。目を動かさないで。',
    reveal: '周りの色が消えましたか？画面は最初から一度も変わっていません。',
    ending: '消したのは画面ではなく、あなたの脳です。トロクスラー効果といいます。',
  },
  es: {
    intro: 'Mira solo el punto rojo del centro. No muevas los ojos.',
    reveal: '¿Desaparecieron los colores? La pantalla nunca cambió, ni una sola vez.',
    ending: 'Los borró tu cerebro, no la pantalla. Se llama efecto Troxler.',
  },
};

export function txNarration(locale = 'ko') {
  return pick(TX, locale);
}

/* ============================================================
   2D:4D 손가락 길이비 — 유사과학 주장을 논문으로 갈라내는 포맷
   ⚠️ 수치는 전부 검증본만: 성차 메타분석 51연구·227,648명(Swift-Gallant 2025),
      태아기 호르몬 근거 재현 실패(Richards 2021), 효과크기 '극히 작음'(Richards/Medland/Beaton 2021)
   ============================================================ */
const DR = {
  ko: {
    intro: '당신의 약지, 검지보다 긴가요? 지금 손을 펴서 비교해보세요.',
    types: '크게 세 가지입니다. 약지가 길거나, 거의 같거나, 검지가 길거나. 인터넷에서는 이걸로 재물운과 리더십을 말하죠.',
    truth: '논문은 이렇게 말합니다. 남녀 평균 차이는 실재합니다. 오십한 개 연구, 이십이만 칠천 명 분석에서 남성이 일관되게 낮았어요. 하지만 태아기 호르몬이 원인이라는 핵심 근거는 재현에 실패했고, 성격이나 손잡이와의 연관은 효과 크기가 극히 작아 개인을 예측할 수는 없습니다.',
    ending: '재물운은 못 봅니다. 그래도 당신은 어느 쪽인가요? 댓글로 알려주세요.',
  },
  en: {
    intro: 'Is your ring finger longer than your index finger? Open your hand and compare right now.',
    types: 'There are three types. Ring longer, almost equal, or index longer. Online, people claim this reveals wealth and leadership.',
    truth: 'Here is what the research says. The average difference between men and women is real. Across fifty one studies and two hundred twenty seven thousand people, men were consistently lower. But the core claim, that prenatal hormones cause it, failed to replicate. And links to personality or handedness are so small they predict nothing about you.',
    ending: 'It cannot read your future. But which one are you? Tell us in the comments.',
  },
  ja: {
    intro: 'あなたの薬指、人差し指より長いですか？今すぐ手を開いて比べてみてください。',
    types: '大きく三つです。薬指が長い、ほぼ同じ、人差し指が長い。ネットではこれで金運やリーダー気質を語りますよね。',
    truth: '論文はこう言っています。男女の平均差は実在します。五十一の研究、二十二万七千人の分析で男性が一貫して低かった。ただし胎児期ホルモンが原因という中心的な根拠は再現に失敗し、性格や利き手との関連は効果量が極めて小さく、個人を予測することはできません。',
    ending: '金運はわかりません。それでもあなたはどっち？コメントで教えてください。',
  },
  es: {
    intro: '¿Tu dedo anular es más largo que el índice? Abre la mano y compara ahora mismo.',
    types: 'Hay tres tipos. Anular más largo, casi iguales, o índice más largo. En internet dicen que esto revela dinero y liderazgo.',
    truth: 'Esto dice la ciencia. La diferencia media entre hombres y mujeres es real. En cincuenta y un estudios con doscientas veintisiete mil personas, ellos siempre más bajo. Pero la base principal, que las hormonas prenatales lo causan, no se pudo replicar. Y los vínculos con la personalidad o la lateralidad son tan pequeños que no predicen nada sobre ti.',
    ending: 'No lee tu futuro. Pero, ¿cuál eres tú? Cuéntanos en los comentarios.',
  },
};

export function drNarration(locale = 'ko') {
  return pick(DR, locale);
}

/* ============================================================
   유튜브 메타데이터 (제목 / 설명 / 태그)
   ============================================================ */
const META = {
  colorVision: {
    ko: { title: '숨은 숫자가 보이나요? 3번은 진짜 어렵습니다', desc: '원판 속에 숫자가 숨어 있습니다. 몇 개나 보이시나요?\n\n※ 재미용 콘텐츠이며 의학적 진단이 아닙니다. 정확한 검사는 안과에서 받으세요.', tags: ['색각테스트', '숨은숫자', '시력테스트', '이시하라', '두뇌테스트'] },
    en: { title: 'Can you see the hidden number? Plate 3 is brutal', desc: 'A number is hiding in each circle. How many can you find?\n\n※ For entertainment only — not a medical diagnosis.', tags: ['color blind test', 'hidden number', 'vision test', 'ishihara', 'eye test'] },
    ja: { title: '隠れた数字が見えますか？3枚目は本当に難しい', desc: '円の中に数字が隠れています。何個見えましたか？\n\n※ 娯楽用であり医学的診断ではありません。', tags: ['色覚テスト', '隠れた数字', '視力テスト', '石原式', '脳トレ'] },
    es: { title: '¿Ves el número escondido? La lámina 3 es brutal', desc: 'Hay un número escondido en cada círculo. ¿Cuántos encuentras?\n\n※ Solo por diversión — no es un diagnóstico médico.', tags: ['test daltonismo', 'numero escondido', 'test de vision', 'ishihara', 'test visual'] },
  },
  digitRatio: {
    ko: { title: '약지가 검지보다 길면 재물운? 논문을 찾아봤습니다', desc: '검지(2D)와 약지(4D)의 길이비를 두고 인터넷에서는 재물운·성격을 말합니다. 실제 연구는 어디까지 말하는지 정리했습니다.\n\n· 성차 메타분석 51개 연구·227,648명 (Swift-Gallant et al., Front Psychol 2025) https://pubmed.ncbi.nlm.nih.gov/40351575/\n· 태아기 호르몬 근거 재현 실패 (Richards et al., J Dev Orig Health Dis 2021) https://pubmed.ncbi.nlm.nih.gov/33472723/\n· 손잡이 연관 효과크기 극히 작음 (Richards, Medland & Beaton, Laterality 2021)', tags: ['손가락길이', '2D4D', '심리테스트', '과학', '유사과학'] },
    en: { title: 'Long ring finger = wealth? I checked the actual studies', desc: 'The internet claims your 2D:4D finger ratio reveals wealth and personality. Here is how far the research actually goes.\n\n· Sex-difference meta-analysis, 51 studies, 227,648 people (Swift-Gallant et al., Front Psychol 2025) https://pubmed.ncbi.nlm.nih.gov/40351575/\n· Prenatal hormone evidence failed to replicate (Richards et al., 2021) https://pubmed.ncbi.nlm.nih.gov/33472723/\n· Handedness link: effect sizes extremely small (Richards, Medland & Beaton, Laterality 2021)', tags: ['finger length test', '2d4d', 'digit ratio', 'psychology', 'pseudoscience'] },
    ja: { title: '薬指が長いと金運？論文を調べました', desc: 'ネットでは2D:4D（人差し指と薬指の比）で金運や性格を語ります。研究が実際にどこまで言えるのか整理しました。\n\n· 性差メタ分析 51研究・227,648人 (Swift-Gallant et al., 2025) https://pubmed.ncbi.nlm.nih.gov/40351575/\n· 胎児期ホルモン根拠の再現失敗 (Richards et al., 2021) https://pubmed.ncbi.nlm.nih.gov/33472723/', tags: ['指の長さ', '2D4D', '心理テスト', '科学', '疑似科学'] },
    es: { title: '¿Anular largo = dinero? Busqué los estudios reales', desc: 'En internet dicen que la proporción 2D:4D revela dinero y personalidad. Esto es hasta dónde llega la ciencia de verdad.\n\n· Metaanálisis de diferencias por sexo, 51 estudios, 227.648 personas (Swift-Gallant et al., 2025) https://pubmed.ncbi.nlm.nih.gov/40351575/\n· La evidencia hormonal prenatal no se replicó (Richards et al., 2021) https://pubmed.ncbi.nlm.nih.gov/33472723/', tags: ['longitud dedos', '2d4d', 'test psicologico', 'ciencia', 'pseudociencia'] },
  },
  troxler: {
    ko: { title: '10초만 점을 보세요. 색이 사라집니다', desc: '가운데 빨간 점을 응시하면 주변 색이 사라집니다. 화면은 전혀 바뀌지 않아요 — 지우는 건 당신의 뇌입니다.\n\n트록슬러 효과(Troxler fading). 시선이 고정되면 뇌가 흐릿한 주변부를 배경으로 처리합니다.', tags: ['착시', '트록슬러효과', '시각착시', '뇌테스트', '눈테스트'] },
    en: { title: 'Stare for 10 seconds. The colors vanish.', desc: 'Fix your eyes on the red dot and the surrounding colors disappear. The screen never changes — your brain erases them.\n\nThis is Troxler fading: hold your gaze and the brain treats soft-edged periphery as background.', tags: ['optical illusion', 'troxler effect', 'visual illusion', 'brain test', 'eye test'] },
    ja: { title: '10秒見つめて。色が消えます', desc: '真ん中の赤い点を見つめると周りの色が消えます。画面は変わりません — 消しているのはあなたの脳です。\n\nトロクスラー効果。視線が止まると、脳は輪郭のぼやけた周辺を背景として処理します。', tags: ['錯覚', 'トロクスラー効果', '目の錯覚', '脳トレ', '視覚テスト'] },
    es: { title: 'Mira 10 segundos. Los colores desaparecen.', desc: 'Fija la vista en el punto rojo y los colores de alrededor desaparecen. La pantalla nunca cambia — tu cerebro los borra.\n\nEs el efecto Troxler: al fijar la mirada, el cerebro trata la periferia difusa como fondo.', tags: ['ilusion optica', 'efecto troxler', 'ilusion visual', 'test mental', 'test visual'] },
  },
  attention: {
    ko: { title: '빨간 공, 몇 번 튕겼을까요? 그런데 그거, 보셨나요?', desc: '빨간 공이 튕기는 횟수를 세어보세요. 그리고 화면을 가로지른 무언가를 보셨나요?\n\n무주의 맹시(inattentional blindness) 실험을 재현했습니다.', tags: ['집중력테스트', '무주의맹시', '관찰력', '두뇌테스트', '착시'] },
    en: { title: 'How many bounces? But wait — did you see it?', desc: 'Count the bounces of the red ball. Then ask yourself what else crossed the screen.\n\nA recreation of the classic inattentional blindness experiment.', tags: ['attention test', 'inattentional blindness', 'observation test', 'brain test', 'focus test'] },
    ja: { title: '何回はねた？ところで、あれ見えましたか？', desc: '赤いボールがはねる回数を数えてください。そして画面を横切った何かに気づきましたか？\n\n非注意性盲目の実験を再現しました。', tags: ['集中力テスト', '非注意性盲目', '観察力', '脳トレ', '錯覚'] },
    es: { title: '¿Cuántos rebotes? Pero espera — ¿lo viste?', desc: 'Cuenta los rebotes de la pelota roja. Y luego pregúntate qué más cruzó la pantalla.\n\nUna recreación del clásico experimento de ceguera por falta de atención.', tags: ['test de atencion', 'ceguera por inatencion', 'test de observacion', 'test mental', 'ilusion'] },
  },
};

/** 포맷+로케일 → 유튜브 메타데이터 (없으면 한국어 폴백) */
export function ytMeta(format, locale = 'ko') {
  const f = META[format] || META.colorVision;
  return f[locale] || f.ko;
}
