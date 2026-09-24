// OCR 엔진 선택 · 글자 단위 가중 투표. Paddle 서버와 tesseract 는 가짜로 바꾼다.
import { describe, it, expect } from 'vitest';
import { roverVote, pickPivot, readText, DEFAULT_WEIGHTS } from '../../server/ocrEnsemble.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const p = (text) => ({ engine: 'paddle', text });
const t = (text) => ({ engine: 'tesseract', text });
const e = (text) => ({ engine: 'paddle_en', text });

describe('roverVote — 글자 단위 가중 투표', () => {
  it('영문은 tesseract 세 표 + 영문 모델이 모이면 Paddle 한국어 모델을 이긴다 (lnvoice → Invoice)', () => {
    expect(roverVote([p('lnvoice #2048'), e('Invoice #2048'), t('Invoice #2048'), t('Invoice #2048'), t('Invoice #2048')])).toBe('Invoice #2048');
  });

  it('한글은 Paddle 을 크게 믿는다 — tesseract 가 흔히 틀리는 이→미 는 뒤집지 못한다', () => {
    expect(roverVote([p('연체 이자가'), t('면체 미자가'), t('연체 미자가'), t('면체 이자가')])).toBe('연체 이자가');
  });

  it('영문 모델은 한글 자리에 투표하지 않는다 — 한글 줄을 엉뚱한 영문으로 읽어도 영향 없음', () => {
    expect(roverVote([p('결제 수단 관리'), e('ZAl 4Et ETel'), e('ZAl 4Et ETel'), e('ZAl 4Et ETel')])).toBe('결제 수단 관리');
  });

  it('빠진 글자를 문자열째 끼워 넣는다 (Wi-F → Wi-Fi)', () => {
    expect(roverVote([p('Wi-F 연결'), t('Wi-Fi 연결'), t('Wi-Fi 연결'), t('Wi-Fi 연결')])).toBe('Wi-Fi 연결');
  });

  it('후보가 하나면 그대로, 없으면 빈 문자열', () => {
    expect(roverVote([p('설정 저장')])).toBe('설정 저장');
    expect(roverVote([])).toBe('');
  });

  it('기본 가중치가 한글은 Paddle, 영문은 tesseract 쪽으로 기운다', () => {
    expect(DEFAULT_WEIGHTS.hangulPaddle).toBeGreaterThan(DEFAULT_WEIGHTS.hangulTess);
    expect(3 * DEFAULT_WEIGHTS.latinTess + DEFAULT_WEIGHTS.latinPaddleEn).toBeGreaterThan(DEFAULT_WEIGHTS.latinPaddle);
  });
});

describe('pickPivot — 통째로 망가진 후보를 기준 줄로 삼지 않는다', () => {
  it('영문 줄에서 한국어 모델이 "ua ng" 로 읽으면 tesseract 쪽이 기준이 된다', () => {
    const cands = [p('ua ng'), t('The unexamined life'), t('The unexamined life'), t('The unexamined lite')];
    expect(pickPivot(cands)).not.toBe(0);
    expect(roverVote(cands)).toBe('The unexamined life');
  });
});

/* ---------- 엔진 선택 ---------- */

const paddleLine = (text, en = text) => ({
  box: [10, 20, 100, 16],
  paddle: { text, score: 0.97 },
  paddleEn: { text: en, score: 0.5 },
  crops: { orig: 'AAAA', up2: 'BBBB', up3bin: 'CCCC' },
});
const fakeTess = async () => ({ text: '테서랙트 결과', lines: [{ text: '테서랙트 결과' }], words: [], confidence: 70, simulated: false });

describe('readText — auto · paddle · ensemble · tesseract', () => {
  it('auto: Paddle 서버가 있으면 Paddle 결과를 쓰고 tesseract 줄 인식은 부르지 않는다', async () => {
    let lineCalls = 0;
    const r = await readText({
      image: PNG,
      _deps: { paddle: async () => ({ lines: [paddleLine('결제 수단 관리'), paddleLine('설정 저장')], ms: 50 }), recognizeLine: async () => { lineCalls++; return ''; }, tesseract: fakeTess },
    });
    expect(r.engine).toBe('paddle');
    expect(r.text).toBe('결제 수단 관리\n설정 저장');
    expect(r.lines[0]).toMatchObject({ confidence: 97, box: { x: 10, y: 20, w: 100, h: 16 } });
    expect(lineCalls).toBe(0);
  });

  it('auto: Paddle 서버가 없으면 tesseract 로 떨어지고 이유를 남긴다', async () => {
    const r = await readText({ image: PNG, _deps: { paddle: async () => { throw new Error('ECONNREFUSED'); }, tesseract: fakeTess } });
    expect(r.engine).toBe('tesseract');
    expect(r.text).toBe('테서랙트 결과');
    expect(r.note).toMatch(/Paddle OCR 서버가 없어/);
  });

  it('paddle 을 명시했는데 서버가 없으면 조용히 바꾸지 않고 오류', async () => {
    const r = await readText({ image: PNG, engine: 'paddle', _deps: { paddle: async () => { throw new Error('ECONNREFUSED'); }, tesseract: fakeTess } });
    expect(r.error).toBe(true);
  });

  it('ensemble: 줄마다 tesseract 를 3번 읽고 투표한다', async () => {
    const seen = [];
    const r = await readText({
      image: PNG, engine: 'ensemble',
      _deps: {
        paddle: async () => ({ lines: [paddleLine('lnvoice #2048', 'Invoice #2048')] }),
        recognizeLine: async (b64) => { seen.push(b64); return 'Invoice #2048'; },
      },
    });
    expect(seen).toEqual(['AAAA', 'BBBB', 'CCCC']);
    expect(r.engine).toBe('paddle+tesseract');
    expect(r.lines[0].text).toBe('Invoice #2048');
    expect(r.lines[0].candidates).toHaveLength(5);
  });

  it('tesseract: Paddle 서버를 부르지 않는다', async () => {
    let called = false;
    const r = await readText({ image: PNG, engine: 'tesseract', _deps: { paddle: async () => { called = true; return { lines: [] }; }, tesseract: fakeTess } });
    expect(called).toBe(false);
    expect(r.engine).toBe('tesseract');
  });

  it('이미지가 잘못되면 던지지 않고 오류를 담아 돌려준다', async () => {
    const r = await readText({ image: 'C:/없는폴더/x.png' });
    expect(r.simulated).toBe(true);
    expect(r.error).toMatch(/찾을 수 없습니다/);
  });
});
