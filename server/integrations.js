// ============================================================
// 실제 연동 — 저장된 크리덴셜(복호화)로 외부 API를 호출한다.
// nodeTypes 의 연동 노드가 globalThis.__conduitIntegrations 로 사용.
// 크리덴셜이 없으면 { simulated:true } 를 돌려 노드가 항상 "동작"하게 한다.
// ============================================================
import nodemailer from 'nodemailer';
import { Credentials } from './store.js';

// 크리덴셜 저장소 → 없으면 .env 폴백
const ENV_FALLBACK = {
  slack: () => (process.env.SLACK_BOT_TOKEN ? { token: process.env.SLACK_BOT_TOKEN } : null),
  notion: () => (process.env.NOTION_TOKEN ? { token: process.env.NOTION_TOKEN } : null),
  youtube: () => (process.env.YOUTUBE_API_KEY ? { apiKey: process.env.YOUTUBE_API_KEY } : null),
  naver: () =>
    process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET
      ? { clientId: process.env.NAVER_CLIENT_ID, clientSecret: process.env.NAVER_CLIENT_SECRET }
      : null,
  gmail: () =>
    process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD
      ? { user: process.env.GMAIL_USER, appPassword: process.env.GMAIL_APP_PASSWORD }
      : null,
};

function findCred(type, name) {
  const list = Credentials.all().filter((c) => c.type === type);
  const c = name ? list.find((x) => x.name === name) : list[0];
  if (c) {
    try {
      return Credentials.reveal(c.id);
    } catch {
      /* 복호화 실패 시 env 폴백 */
    }
  }
  return ENV_FALLBACK[type]?.() || null;
}

const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, '');

/* ---------- Slack ---------- */
export async function slack({ credential, channel, text }) {
  const cred = findCred('slack', credential);
  if (!cred?.token) return { simulated: true, note: 'Slack 크리덴셜(Bot Token) 없음' };
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cred.token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel, text }),
  });
  const data = await res.json();
  return data.ok ? { ok: true, channel: data.channel, ts: data.ts } : { ok: false, error: data.error };
}

/* ---------- Gmail (앱 비밀번호 · SMTP) ---------- */
export async function gmail({ credential, to, subject, text }) {
  const cred = findCred('gmail', credential);
  if (!cred?.user || !cred?.appPassword) return { simulated: true, note: 'Gmail 크리덴셜(user/appPassword) 없음' };
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: cred.user, pass: cred.appPassword },
  });
  const info = await transporter.sendMail({ from: cred.user, to, subject, text });
  return { ok: true, messageId: info.messageId, accepted: info.accepted };
}

/* ---------- Notion ---------- */
export async function notion({ credential, databaseId, titleProp, title, content }) {
  const cred = findCred('notion', credential);
  if (!cred?.token) return { simulated: true, note: 'Notion 크리덴셜(Integration Token) 없음' };
  const body = {
    parent: { database_id: databaseId },
    properties: { [titleProp || 'Name']: { title: [{ text: { content: String(title || '') } }] } },
  };
  if (content) {
    body.children = [
      { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: String(content) } }] } },
    ];
  }
  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cred.token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data.object === 'page' ? { ok: true, id: data.id, url: data.url } : { ok: false, error: data.message };
}

/* ---------- YouTube Data API ---------- */
export async function youtube({ credential, query, maxResults }) {
  const cred = findCred('youtube', credential);
  if (!cred?.apiKey) return { simulated: true, note: 'YouTube 크리덴셜(API Key) 없음' };
  const url =
    `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video` +
    `&maxResults=${maxResults || 5}&q=${encodeURIComponent(query || '')}&key=${cred.apiKey}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) return { ok: false, error: data.error.message };
  const items = (data.items || []).map((it) => ({
    videoId: it.id.videoId,
    url: `https://youtu.be/${it.id.videoId}`,
    title: it.snippet.title,
    channel: it.snippet.channelTitle,
    publishedAt: it.snippet.publishedAt,
  }));
  return { ok: true, count: items.length, items };
}

/* ---------- Naver Open API ---------- */
export async function naver({ credential, type, query, display }) {
  const cred = findCred('naver', credential);
  if (!cred?.clientId || !cred?.clientSecret) return { simulated: true, note: 'Naver 크리덴셜(Client ID/Secret) 없음' };
  const t = type || 'news';
  const res = await fetch(
    `https://openapi.naver.com/v1/search/${t}.json?query=${encodeURIComponent(query || '')}&display=${display || 5}`,
    { headers: { 'X-Naver-Client-Id': cred.clientId, 'X-Naver-Client-Secret': cred.clientSecret } }
  );
  const data = await res.json();
  if (data.errorCode) return { ok: false, error: data.errorMessage };
  const items = (data.items || []).map((it) => ({
    title: stripTags(it.title),
    link: it.link,
    description: stripTags(it.description),
  }));
  return { ok: true, count: items.length, items };
}

/* ---------- 범용 인증 HTTP (거의 모든 REST API) ---------- */
export async function http({ credential, authType, method, url, headers, body }) {
  const cred = authType && authType !== 'none' ? findCred('httpAuth', credential) : null;
  if (authType && authType !== 'none' && !cred) {
    return { simulated: true, note: `httpAuth 크리덴셜 없음 (authType=${authType})` };
  }

  const h = {};
  if (headers) { try { Object.assign(h, JSON.parse(headers)); } catch { /* ignore */ } }

  if (authType === 'bearer') h.Authorization = `Bearer ${cred.token || ''}`;
  else if (authType === 'header') h[cred.headerName || 'X-API-Key'] = cred.headerValue || cred.token || '';
  else if (authType === 'basic') h.Authorization = 'Basic ' + Buffer.from(`${cred.user || ''}:${cred.pass || ''}`).toString('base64');

  const opt = { method: method || 'GET', headers: h };
  if (opt.method !== 'GET' && body) {
    if (!h['Content-Type']) h['Content-Type'] = 'application/json';
    opt.body = body;
  }

  const res = await fetch(url, opt);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  return { ok: res.ok, status: res.status, data };
}
