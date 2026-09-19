// 채널 관제 대시보드 — YouTube 통계 API + 정적 대시보드 페이지
import { Router } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const WEEK_VIDEOS = [
  { id: 'gcmHlHI0ias', day: '일', name: '고양이 회전 착시' },
  { id: 'LA27Sm5cgTM', day: '월', name: '색각 숨은 숫자' },
  { id: '1lRyPFZgUqQ', day: '화', name: '집중력 반전' },
  { id: 'fbCpICUyjKk', day: '수', name: '청력 나이 (포맷 중단)' },
  // 목 '정신연령'(850ScUCEt2w)은 성과 부진으로 삭제됨 — 조회 시 404가 나므로 목록에서 제외
];

/* ---------- /api/channel/stats (인증 필요) ---------- */
export const channelApi = Router();
channelApi.get('/stats', async (_req, res) => {
  try {
    const tok = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.YOUTUBE_CLIENT_ID, client_secret: process.env.YOUTUBE_CLIENT_SECRET,
        refresh_token: process.env.YOUTUBE_REFRESH_TOKEN, grant_type: 'refresh_token',
      }),
    }).then((r) => r.json());
    if (!tok.access_token) return res.status(500).json({ error: 'YouTube 토큰 갱신 실패 (.env 확인)' });
    const H = { Authorization: `Bearer ${tok.access_token}` };
    const ids = WEEK_VIDEOS.map((v) => v.id).join(',');
    const [vids, ch] = await Promise.all([
      fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics,status,snippet&id=${ids}`, { headers: H }).then((r) => r.json()),
      fetch('https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true', { headers: H }).then((r) => r.json()),
    ]);
    const videos = WEEK_VIDEOS.map((w) => {
      const it = (vids.items || []).find((x) => x.id === w.id);
      return it ? {
        ...w, title: it.snippet.title, privacy: it.status.privacyStatus, publishAt: it.status.publishAt || null,
        views: Number(it.statistics.viewCount || 0), likes: Number(it.statistics.likeCount || 0), comments: Number(it.statistics.commentCount || 0),
      } : { ...w, missing: true };
    });
    res.json({ channel: ch.items?.[0]?.statistics || {}, videos, at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- /dashboard (정적 페이지 · 공개) ---------- */
export const dashboardPage = Router();
dashboardPage.get('/', (_req, res) => res.sendFile(path.join(here, '..', 'dashboard.html')));
