// ============================================================
// Google Blogger(블로그스팟) 발행 — Blogger API v3 posts.insert
//   • 인증: OAuth 리프레시 토큰 (YouTube 업로드와 같은 GCP 클라이언트 재사용 가능)
//     - GCP 콘솔에서 Blogger API v3 사용 설정
//     - scope https://www.googleapis.com/auth/blogger 로 리프레시 토큰 발급
//       (기존 유튜브 토큰에는 blogger 스코프가 없어 재동의 필요 — 루프백 8791 패턴)
//   • .env: BLOGGER_BLOG_ID, BLOGGER_REFRESH_TOKEN (+ 클라이언트는 BLOGGER_* 우선, 없으면 YOUTUBE_* 재사용)
//   • 키가 없으면 시뮬레이션 — 포스트 파일 경로만 안내
// ============================================================
import { Credentials } from './store.js';
import { PublishedPosts } from './store.js';

function getCred() {
  const clientId = process.env.BLOGGER_CLIENT_ID || process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.BLOGGER_CLIENT_SECRET || process.env.YOUTUBE_CLIENT_SECRET;
  const refreshToken = process.env.BLOGGER_REFRESH_TOKEN;
  const blogId = process.env.BLOGGER_BLOG_ID;
  if (clientId && clientSecret && refreshToken) return { clientId, clientSecret, refreshToken, blogId };
  const cred = Credentials.all().find((c) => c.type === 'blogger');
  if (cred) {
    try {
      const d = Credentials.reveal(cred.id);
      if (d.clientId && d.refreshToken) return d;
    } catch { /* 시뮬레이션 폴백 */ }
  }
  return null;
}

async function accessToken(cred) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cred.clientId,
      client_secret: cred.clientSecret,
      refresh_token: cred.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const token = await res.json();
  if (!token.access_token) throw new Error('Blogger 토큰 갱신 실패: ' + (token.error_description || token.error));
  return token.access_token;
}

export async function publishPost({ blogId, title, html, labels, isDraft = true, metaDescription = '', keyword = '', network = '' } = {}) {
  const cred = getCred();
  const targetBlog = blogId || cred?.blogId;
  if (!cred) {
    return {
      simulated: true,
      note: 'Blogger 크리덴셜 없음 — .env의 BLOGGER_REFRESH_TOKEN/BLOGGER_BLOG_ID 채우면 실제 발행. 그동안 포스트는 server/data/blogposts/ HTML로 저장됨(네이버 복붙 가능)',
    };
  }
  if (!targetBlog) return { ok: false, error: 'BLOGGER_BLOG_ID 가 없습니다 (블로그 주소의 blogID)' };
  if (!title || !html) return { ok: false, error: 'title/html 이 비어 있습니다' };

  const token = await accessToken(cred);
  const draft = String(isDraft) !== 'false';
  const labelList = Array.isArray(labels)
    ? labels
    : String(labels || '').split(',').map((s) => s.trim()).filter(Boolean);

  const res = await fetch(
    `https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(targetBlog)}/posts/?isDraft=${draft}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'blogger#post',
        title: String(title).slice(0, 150),
        content: String(html),
        ...(labelList.length ? { labels: labelList.slice(0, 20) } : {}),
        // 검색결과 스니펫으로 쓰이는 설명문 (Blogger 의 "검색 설명" 필드)
        ...(metaDescription ? { customMetaData: String(metaDescription).slice(0, 300) } : {}),
      }),
    }
  );
  const data = await res.json();
  if (data.error) return { ok: false, error: data.error.message };
  // 발행된 글을 기록해 두어야 다음 글에서 내부 링크로 걸 수 있다.
  // 초안은 공개 URL 이 아니므로 기록하지 않는다.
  if (!draft && data.url) {
    PublishedPosts.add({ postId: data.id, url: data.url, title, keyword, labels: labelList, network });
  }
  return { ok: true, id: data.id, url: data.url, status: draft ? 'draft' : 'published' };
}
