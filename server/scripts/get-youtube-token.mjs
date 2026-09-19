// YouTube OAuth 재발급 — 루프백(127.0.0.1:8791) 수신기.
// .env 의 CLIENT_ID/SECRET 으로 동의 URL 을 만들고, 콜백에서 코드를 토큰으로 바꿔 .env 에 기록한다.
// 비밀값(시크릿·토큰)은 절대 출력하지 않는다.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';

const ENV = 'C:/workflow/flowforge/.env';
const parse = (t) => Object.fromEntries(
  t.split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const env = parse(fs.readFileSync(ENV, 'utf8'));
const CLIENT_ID = env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = env.YOUTUBE_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) { console.log('MISSING client id/secret in .env'); process.exit(1); }

const PORT = 8791;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.force-ssl', // 댓글 API
].join(' ');
const state = crypto.randomUUID();

const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
auth.search = new URLSearchParams({
  client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPES,
  access_type: 'offline', prompt: 'consent', state,
}).toString();
console.log('AUTH_URL=' + auth.toString());

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
  const done = (html) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); };
  if (u.searchParams.get('state') !== state) { done('<h2>state 불일치 — 다시 시도하세요</h2>'); console.log('STATE_MISMATCH'); return; }
  const err = u.searchParams.get('error');
  if (err) { done(`<h2>동의가 취소됐습니다 (${err})</h2>`); console.log('ERROR=' + err); server.close(); return; }

  const tok = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: u.searchParams.get('code'), client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT, grant_type: 'authorization_code' }),
  }).then((r) => r.json());
  if (!tok.refresh_token) {
    done('<h2>리프레시 토큰이 오지 않았습니다</h2>');
    console.log('NO_REFRESH ' + (tok.error || '') + ' ' + (tok.error_description || '') + ' keys=' + Object.keys(tok).join(','));
    server.close(); return;
  }

  let text = fs.readFileSync(ENV, 'utf8');
  if (/^YOUTUBE_REFRESH_TOKEN=.*$/m.test(text)) text = text.replace(/^YOUTUBE_REFRESH_TOKEN=.*$/m, 'YOUTUBE_REFRESH_TOKEN=' + tok.refresh_token);
  else text += (text.endsWith('\n') ? '' : '\n') + 'YOUTUBE_REFRESH_TOKEN=' + tok.refresh_token + '\n';
  fs.writeFileSync(ENV, text);

  const ch = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', {
    headers: { Authorization: 'Bearer ' + tok.access_token },
  }).then((r) => r.json());
  const c = ch.items?.[0];
  done('<h2>Conduit — YouTube 토큰 발급 완료. 이 창은 닫아도 됩니다.</h2>');
  console.log(`OK scopes=${tok.scope} channel=${c?.snippet?.title ?? '?'} subs=${c?.statistics?.subscriberCount ?? '?'} videos=${c?.statistics?.videoCount ?? '?'}`);
  server.close();
});
server.listen(PORT, '127.0.0.1', () => console.log('LISTENING ' + REDIRECT));
setTimeout(() => { console.log('TIMEOUT'); server.close(); process.exit(2); }, 15 * 60 * 1000);
