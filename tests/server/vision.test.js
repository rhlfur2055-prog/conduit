// 화면 인식(OCR + vision) 단위 테스트.
// 실제 OCR 은 tesseract.js 가 언어 데이터를 네트워크로 내려받으므로 CI 를 느리고
// 불안정하게 만든다. 그래서 기본은 순수 로직만 돌리고, 진짜 OCR 은
// CONDUIT_TEST_OCR=1 일 때만 실행한다. (로컬 확인용: npm test 앞에 환경변수)
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadImage, parseJson, understandScreen, ocr, closeOcr } from '../../server/vision.js';

// 1x1 투명 PNG
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('loadImage — 경로·data:URL·base64 를 모두 받는다', () => {
  it('data:URL 에서 media type 과 base64 를 뽑는다', () => {
    const r = loadImage(`data:image/jpeg;base64,${PNG_1X1}`);
    expect(r.mediaType).toBe('image/jpeg');
    expect(r.base64).toBe(PNG_1X1);
  });

  it('파일 경로를 읽어 확장자로 media type 을 정한다', () => {
    const f = path.join(os.tmpdir(), `conduit-vision-${Date.now()}.png`);
    fs.writeFileSync(f, Buffer.from(PNG_1X1, 'base64'));
    try {
      const r = loadImage(f);
      expect(r.mediaType).toBe('image/png');
      expect(r.base64).toBe(PNG_1X1);
    } finally { fs.rmSync(f, { force: true }); }
  });

  it('경로에는 . 과 : 가 들어가므로 base64 로 오해하지 않는다', () => {
    expect(() => loadImage('C:/없는폴더/screenshot.png')).toThrow(/찾을 수 없습니다/);
  });

  it('빈 값은 명확히 거부한다', () => {
    expect(() => loadImage('')).toThrow(/비어 있습니다/);
    expect(() => loadImage(null)).toThrow(/비어 있습니다/);
  });
});

describe('parseJson — 모델이 군더더기를 붙여도 JSON 을 건진다', () => {
  it('순수 JSON', () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('```json 코드펜스로 감싼 경우', () => {
    expect(parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('앞뒤로 설명 문장이 붙은 경우', () => {
    expect(parseJson('네, 분석했습니다:\n{"screenType":"결제"}\n도움이 되었길!'))
      .toEqual({ screenType: '결제' });
  });
  it('JSON 이 아예 없으면 null', () => {
    expect(parseJson('JSON 이 없습니다')).toBeNull();
    expect(parseJson('')).toBeNull();
  });
});

describe('화면 이해 — 키가 없어도 워크플로를 막지 않는다', () => {
  it('API 키가 없으면 시뮬레이션으로 떨어지고 이유를 남긴다', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const r = await understandScreen({
        image: `data:image/png;base64,${PNG_1X1}`,
        withOcr: false,            // OCR 은 여기서 돌리지 않는다 (네트워크 불필요)
      });
      expect(r.simulated).toBe(true);
      expect(r.note).toMatch(/ANTHROPIC_API_KEY/);
    } finally { if (saved) process.env.ANTHROPIC_API_KEY = saved; }
  });

  it('이미지가 잘못되면 던지지 않고 오류를 담아 돌려준다', async () => {
    const r = await understandScreen({ image: 'C:/없는폴더/x.png' });
    expect(r.simulated).toBe(true);
    expect(r.error).toMatch(/찾을 수 없습니다/);
  });

  it('OCR 도 이미지가 잘못되면 던지지 않는다', async () => {
    const r = await ocr({ image: 'C:/없는폴더/x.png' });
    expect(r.simulated).toBe(true);
    expect(r.text).toBe('');
    expect(r.words).toEqual([]);
  });
});

// 실제 OCR — 언어 데이터를 내려받으므로 기본 비활성
describe.runIf(process.env.CONDUIT_TEST_OCR === '1')('실제 OCR (CONDUIT_TEST_OCR=1)', () => {
  it('영문 이미지를 읽고 단어 좌표를 준다', async () => {
    const img = process.env.CONDUIT_TEST_OCR_IMAGE;
    if (!img) return;
    const r = await ocr({ image: img, lang: 'eng', minConfidence: 50 });
    expect(r.simulated).toBe(false);
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.words.length).toBeGreaterThan(0);
    expect(r.words[0].box).toHaveProperty('x');
    await closeOcr();
  }, 120000);
});
