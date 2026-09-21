// 채널 관제 대시보드 — YouTube 통계 API + 정적 대시보드 페이지
import { Router } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// 영상 ID를 코드에 박아 두지 않는다 — 채널의 최근 업로드를 그때그때 불러온다.
// (영상을 내리거나 새로 올려도 코드를 고칠 필요가 없다)
const RECENT_COUNT = 7;
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
// 공개(예약) 시각을 한국 시간 기준 요일로
export const dayOfWeekKST = (iso) => DAYS[new Date(new Date(iso).getTime() + 9 * 3600e3).getUTCDay()];

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
    const yt = (pathAndQuery) => fetch(`https://www.googleapis.com/youtube/v3/${pathAndQuery}`, { headers: H }).then((r) => r.json());
    const ch = await yt('channels?part=statistics,contentDetails&mine=true');
    const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    const recent = uploads ? await yt(`playlistItems?part=contentDetails&playlistId=${uploads}&maxResults=${RECENT_COUNT}`) : {};
    const ids = (recent.items || []).map((x) => x.contentDetails.videoId).join(',');
    const vids = ids ? await yt(`videos?part=statistics,status,snippet&id=${ids}`) : {};
    const videos = (vids.items || []).map((it) => ({
      id: it.id, name: it.snippet.title, title: it.snippet.title,
      day: dayOfWeekKST(it.status.publishAt || it.snippet.publishedAt),
      privacy: it.status.privacyStatus, publishAt: it.status.publishAt || null,
      views: Number(it.statistics.viewCount || 0), likes: Number(it.statistics.likeCount || 0), comments: Number(it.statistics.commentCount || 0),
    }));
    res.json({ channel: ch.items?.[0]?.statistics || {}, videos, at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- /dashboard (정적 페이지 · 공개) ---------- */
export const dashboardPage = Router();
dashboardPage.get('/', (_req, res) => res.sendFile(path.join(here, '..', 'dashboard.html')));
