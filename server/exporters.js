// ============================================================
// 포스트 다중 출력 — 한 번 만든 글을 플랫폼별 형식으로 변환
//
//   왜: Blogger 는 API 로 자동 발행되지만, 네이버·티스토리·커뮤니티는
//   자동 포스팅이 약관 위반이라 계정이 정지된다. 대신 각 플랫폼 에디터에
//   "붙여넣기만 하면 깨지지 않는" 형태로 뽑아준다. 붙여넣기는 정상 사용이다.
//
//   대상:
//     blogger  — 원본 HTML 그대로 (API 발행용)
//     naver    — 스마트에디터가 살려주는 태그만 남긴 단순 HTML
//     tistory  — HTML 모드용 (네이버보다 관대해 스타일 일부 유지)
//     markdown — 워드프레스·깃허브·정적사이트·티스토리 마크다운 모드
//     text     — 커뮤니티·카페 글쓰기용 순수 텍스트
// ============================================================

const decode = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&');

/** 목차 앵커(#item-N)는 네이버·마크다운·텍스트에서 동작하지 않는다 → 링크를 풀고 글자만 남긴다 */
const dropAnchors = (s) => String(s).replace(/<a href="#item-\d+"[^>]*>([\s\S]*?)<\/a>/g, '$1');

/** 태그 사이 공백 정리 — 변환 결과가 빈 줄 범벅이 되지 않게 */
const tidy = (s) => s.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();

/* ---------- 네이버 스마트에디터 ----------
   에디터가 인라인 스타일 대부분과 div 중첩을 날린다.
   남는 것만 쓰고, 버튼은 그냥 링크로 내린다(버튼 스타일은 어차피 사라짐). */
export function toNaver(html) {
  let s = String(html);

  // 목차 블록: 앵커 id 가 유실되므로 링크를 풀고 목록만 남긴다
  s = s.replace(/<a href="#item-\d+"[^>]*>([\s\S]*?)<\/a>/g, '$1');

  // CTA 버튼 → 굵은 텍스트 링크
  s = s.replace(
    /<a href="([^"]+)"[^>]*rel="sponsored[^"]*"[^>]*>([\s\S]*?)<\/a>/g,
    (_m, href, label) => `<a href="${href}"><b>${decode(label).replace(/\s+/g, ' ').trim()}</b></a>`
  );

  // 레이아웃용 div/svg 제거 (내용은 보존)
  s = s.replace(/<svg[\s\S]*?<\/svg>/g, '');
  s = s.replace(/<div[^>]*>/g, '').replace(/<\/div>/g, '');

  // 스타일 속성 제거 — 에디터가 자기 스타일을 입힌다
  s = s.replace(/\s+style="[^"]*"/g, '');
  s = s.replace(/\s+(loading|target|rel)="[^"]*"/g, '');
  s = s.replace(/\s+id="item-\d+"/g, '');

  return tidy(s);
}

/* ---------- 티스토리 HTML 모드 ----------
   네이버보다 관대해서 기본 스타일은 살아남는다. div 만 정리한다. */
export function toTistory(html) {
  let s = String(html);
  s = s.replace(/<svg[\s\S]*?<\/svg>/g, '');
  s = s.replace(/\s+loading="lazy"/g, '');
  return tidy(s);
}

/* ---------- 마크다운 ---------- */
export function toMarkdown(html, title = '') {
  let s = dropAnchors(html);

  s = s.replace(/<svg[\s\S]*?<\/svg>/g, '');
  s = s.replace(/<hr[^>]*\/?>/g, '\n---\n');
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/g, (_m, t) => `\n## ${decode(t).trim()}\n`);
  s = s.replace(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>/g, '![$1]($2)');
  s = s.replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/g, '![$2]($1)');
  s = s.replace(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
    (_m, href, t) => `[${decode(t).replace(/\s+/g, ' ').trim()}](${href})`);
  s = s.replace(/<b>([\s\S]*?)<\/b>/g, '**$1**');
  s = s.replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**');
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/g, (_m, t) => `- ${decode(t).replace(/\s+/g, ' ').trim()}\n`);
  s = s.replace(/<\/(ul|ol)>/g, '\n');
  s = s.replace(/<(ul|ol)[^>]*>/g, '');
  s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/g, (_m, t) => `\n${decode(t).replace(/\s+/g, ' ').trim()}\n`);
  s = s.replace(/<[^>]+>/g, '');            // 남은 태그 제거
  s = decode(s);

  s = s.replace(/^[ \t]+([-#])/gm, '$1');   // 리스트·헤딩 앞 들여쓰기 제거
  const head = title ? `# ${title}\n\n` : '';
  return head + tidy(s);
}

/* ---------- 순수 텍스트 (커뮤니티·카페) ----------
   링크는 본문에 그대로 노출해야 클릭이 가능하다. */
export function toText(html, title = '') {
  let s = dropAnchors(html);
  s = s.replace(/<svg[\s\S]*?<\/svg>/g, '');
  s = s.replace(/<hr[^>]*\/?>/g, '\n────────────\n');
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/g, (_m, t) => `\n■ ${decode(t).trim()}\n`);
  s = s.replace(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
    (_m, href, t) => `${decode(t).replace(/\s+/g, ' ').trim()}\n${href}`);
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/g, (_m, t) => `· ${decode(t).replace(/\s+/g, ' ').trim()}\n`);
  s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/g, (_m, t) => `\n${decode(t).replace(/\s+/g, ' ').trim()}\n`);
  s = s.replace(/<[^>]+>/g, '');
  s = decode(s);
  s = s.replace(/^[ \t]+([·■])/gm, '$1');
  return (title ? `${title}\n${'='.repeat(Math.min(title.length * 2, 40))}\n` : '') + tidy(s);
}

/* ---------- 한 번에 전부 ---------- */
export function exportAll(post) {
  const { html, title } = post;
  return {
    blogger: html,
    naver: toNaver(html),
    tistory: toTistory(html),
    markdown: toMarkdown(html, title),
    text: toText(html, title),
  };
}
