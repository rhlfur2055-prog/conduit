// ============================================================
// Blogger refresh token 발급기 (로컬 OAuth)
//
//   이미 있는 Google OAuth 앱(YOUTUBE_CLIENT_ID/SECRET)에 Blogger 스코프를
//   추가로 승인받아 refresh token 을 얻는다. Google 심사 절차 없음.
//
//   기본:     node server/scripts/get-blogger-token.mjs
//   자동기록:  node server/scripts/get-blogger-token.mjs --write   ← 권장
//             (토큰을 화면에 찍지 않고 .env 에 바로 기록)
//   포트변경:  node server/scripts/get-blogger-token.mjs --port=8123 --write
//   수동:     node server/scripts/get-blogger-token.mjs --code=붙여넣은코드 --write
//   진단:     node server/scripts/get-blogger-token.mjs --check
// ============================================================
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(HERE, '..', '..', '.env');
for (const p of [ENV_PATH, path.join(HERE, '..', '.env')]) {
  try { process.loadEnvFile(p); break; } catch { /* 다음 후보 */ }
}

const arg = (name, fallback = '') => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const CLIENT_ID = process.env.BLOGGER_CLIENT_ID || process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.BLOGGER_CLIENT_SECRET || process.env.YOUTUBE_CLIENT_SECRET;
const PORT = Number(arg('port', process.env.OAUTH_PORT || 5599));
const REDIRECT = `http://localhost:${PORT}/callback`;
// blogger 하나만 요청한다. email 을 같이 넣으면 동의 화면이 체크박스 두 개로 갈라지고,
// Blogger 쪽을 안 누른 채 계속하면 토큰이 blogger 권한 없이 발급된다(실제로 겪음).
const SCOPE = 'https://www.googleapis.com/auth/blogger';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n✖ .env 에 YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET 이 없습니다.');
  process.exit(1);
}

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',
  // --pick 을 주면 계정 선택 화면을 강제한다 (블로그를 만든 계정과 토큰 계정이 다를 때)
  prompt: has('pick') ? 'select_account consent' : 'consent',
});

/* ---------- code → 토큰 → 블로그 목록 ---------- */
async function exchange(code) {
  const tokRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT, grant_type: 'authorization_code',
    }),
  });
  const tok = await tokRes.json();
  if (!tok.refresh_token) {
    let hint = '';
    if (tok.error === 'invalid_grant') {
      hint = '\n  → code 는 1회용이고 수 분 내 만료됩니다. 처음부터 다시 실행하세요.';
    } else if (tok.error === 'redirect_uri_mismatch') {
      hint = `\n  → Google Cloud Console 의 이 OAuth 클라이언트에 승인된 리디렉션 URI 로 추가하세요:\n     ${REDIRECT}`;
    }
    throw new Error(`refresh_token 을 받지 못했습니다: ${JSON.stringify(tok)}${hint}`);
  }
  // 어느 계정으로 승인됐는지 확인 (계정 착오를 즉시 잡기 위함)
  let who = '';
  try {
    const info = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + tok.access_token },
    }).then((x) => x.json());
    who = info.email || '';
  } catch { /* 표시용이라 실패해도 진행 */ }
  const blogRes = await fetch('https://www.googleapis.com/blogger/v3/users/self/blogs', {
    headers: { Authorization: 'Bearer ' + tok.access_token },
  });
  const blogs = await blogRes.json();
  return { tok, items: blogs.items || [], blogsError: blogs.error && blogs.error.message, who };
}

/* ---------- .env 에 직접 기록 ----------
   토큰을 화면에 찍지 않는다. 터미널 스크롤백·로그에 남지 않게 하기 위함. */
function writeEnv(refreshToken, blogId) {
  const raw = fs.readFileSync(ENV_PATH, 'utf8');
  fs.writeFileSync(ENV_PATH + '.bak', raw);           // 되돌릴 수 있게 백업
  const eol = raw.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const setKey = (text, key, val) => {
    const re = new RegExp('^' + key + '=.*$', 'm');
    if (re.test(text)) return text.replace(re, key + '=' + val);
    return text.replace(/\s*$/, eol + key + '=' + val + eol);
  };
  let out = setKey(raw, 'BLOGGER_REFRESH_TOKEN', refreshToken);
  if (blogId) out = setKey(out, 'BLOGGER_BLOG_ID', blogId);
  fs.writeFileSync(ENV_PATH, out);
}

function report({ tok, items, blogsError, who }) {
  const chosen = items[0];
  if (who) console.log('\n  승인된 계정 :', who);

  if (has('write')) {
    writeEnv(tok.refresh_token, chosen ? chosen.id : '');
    console.log('\n' + '='.repeat(66));
    console.log(' 발급 성공 — .env 에 자동 기록했습니다');
    console.log('='.repeat(66) + '\n');
    console.log('  파일          :', ENV_PATH, '(원본은 .env.bak 백업)');
    console.log('  REFRESH_TOKEN : 기록됨 (' + tok.refresh_token.length + '자 · 화면 출력 생략)');
    if (chosen) {
      console.log('  BLOG_ID       :', chosen.id, '—', chosen.name);
    } else if (blogsError) {
      // API 미활성화 등을 "블로그 없음" 으로 오인하지 않도록 원인을 그대로 보여준다
      console.log('  BLOG_ID       : 조회 실패 —', blogsError);
    } else {
      console.log('  BLOG_ID       : 이 계정에 블로그가 없습니다. blogger.com 에서 먼저 만드세요.');
    }
    if (items.length > 1) {
      console.log('\n  블로그가 여러 개입니다. 바꾸려면 .env 의 BLOGGER_BLOG_ID 를 수정하세요:');
      for (const b of items) console.log('    ' + b.id + '  ' + b.name);
    }
    console.log('\n  서버를 재시작하면 발행이 활성화됩니다.\n');
    return;
  }

  console.log('\n' + '='.repeat(66));
  console.log(' 발급 성공 — 아래를 .env 에 붙여넣으세요');
  console.log('='.repeat(66) + '\n');
  console.log('BLOGGER_REFRESH_TOKEN=' + tok.refresh_token);
  if (blogsError) {
    console.log('BLOGGER_BLOG_ID=          ← 블로그 목록 조회 실패: ' + blogsError);
  } else if (!chosen) {
    console.log('BLOGGER_BLOG_ID=          ← 이 계정에 블로그가 없습니다.');
  } else {
    console.log('BLOGGER_BLOG_ID=' + chosen.id + '    # ' + chosen.name);
    if (items.length > 1) {
      console.log('\n  다른 블로그를 쓰려면 아래에서 골라 id 를 바꾸세요:');
      for (const b of items) console.log('    ' + b.id + '  ' + b.name + '  (' + b.url + ')');
    }
  }
  console.log('');
}

/* ---------- 진단 ---------- */
if (has('check')) {
  console.log('\n[진단]');
  console.log('  CLIENT_ID     :', CLIENT_ID.slice(0, 12) + '…' + CLIENT_ID.slice(-24));
  console.log('  CLIENT_SECRET : 설정됨 (' + CLIENT_SECRET.length + '자)');
  console.log('  리디렉션 URI  :', REDIRECT);
  console.log('  기존 토큰     :', process.env.BLOGGER_REFRESH_TOKEN ? '있음' : '없음');
  const res = await fetch(authUrl, { redirect: 'manual' });
  console.log('  Google 응답   :', res.status, res.status === 302 ? '(정상)' : '(확인 필요)');
  const busy = await new Promise((r) => {
    const sock = net.connect(PORT, '127.0.0.1');
    sock.once('connect', () => { sock.destroy(); r(true); });
    sock.once('error', () => r(false));
    sock.setTimeout(1200, () => { sock.destroy(); r(false); });
  });
  console.log('  포트', PORT, '    :', busy ? '사용 중 ← --port=8123 으로 바꾸세요' : '사용 가능');
  console.log('\n  인증 URL:\n  ' + authUrl + '\n');
  process.exit(0);
}

/* ---------- 수동 모드 ---------- */
const manualCode = arg('code');
if (manualCode) {
  try {
    report(await exchange(manualCode.trim()));
    process.exit(0);
  } catch (e) {
    console.error('\n✖ ' + e.message + '\n');
    process.exit(1);
  }
}

/* ---------- 기본 모드 ---------- */
console.log('\n' + '='.repeat(66));
console.log(' Blogger refresh token 발급' + (has('write') ? '   (.env 자동 기록)' : ''));
console.log('='.repeat(66));
console.log('\n[1] 브라우저가 열립니다. 안 열리면 아래 주소를 직접 여세요:\n');
console.log(authUrl);
console.log('\n[2] 로그인 → "확인하지 않은 앱" 경고가 뜨면 왼쪽 아래 [고급] →');
console.log('    [<앱이름>(으)로 이동] 을 누르세요. 본인 앱이라 정상입니다.');
console.log('\n[3] Blogger 권한 허용 → 완료됩니다.');
console.log('\n※ 브라우저가 "연결할 수 없음" 을 띄워도 주소창에 code=... 가 보이면 성공입니다.');
console.log('   그 값을 복사해:  node server/scripts/get-blogger-token.mjs --code=붙여넣기 --write');
console.log(`\n대기 중… (${REDIRECT})\n`);

try {
  // Windows 의 'start' 는 cmd 빌트인이라 URL 의 & 를 명령 구분자로 먹는다.
  // (그러면 client_id 뒤가 잘려나가 "Required parameter is missing: response_type" 이 뜬다)
  // rundll32 는 셸 파싱을 거치지 않아 안전하다.
  const opener = process.platform === 'win32'
    ? ['rundll32', ['url.dll,FileProtocolHandler', authUrl]]
    : process.platform === 'darwin' ? ['open', [authUrl]] : ['xdg-open', [authUrl]];
  spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref();
} catch { /* 수동으로 열면 된다 */ }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
  const reply = (msg) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<meta charset="utf-8"><body style="font-family:system-ui;padding:40px;line-height:1.7">${msg}</body>`);
  };
  const err = url.searchParams.get('error');
  const code = url.searchParams.get('code');

  if (err) {
    reply(`<h2>권한 허용이 취소되었습니다</h2><p>오류: ${err}</p>`);
    console.error('\n✖ 권한 거부:', err);
    server.close();
    process.exit(1);
  }
  if (!code) { reply('<h2>코드가 없습니다</h2>'); return; }

  try {
    const out = await exchange(code);
    reply('<h2>발급 완료</h2><p>터미널로 돌아가세요. 이 창은 닫으셔도 됩니다.</p>');
    report(out);
  } catch (e) {
    reply(`<h2>발급 실패</h2><pre style="white-space:pre-wrap">${String(e.message)}</pre>`);
    console.error('\n✖ ' + e.message + '\n');
  } finally {
    server.close();
    setTimeout(() => process.exit(0), 300);
  }
});

server.on('error', (e) => {
  console.error(`\n✖ 포트 ${PORT} 를 열 수 없습니다: ${e.code}`);
  console.error('  다른 포트로:  node server/scripts/get-blogger-token.mjs --port=8123 --write\n');
  process.exit(1);
});
server.listen(PORT);
