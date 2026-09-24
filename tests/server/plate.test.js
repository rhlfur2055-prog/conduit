// 번호판 인식 연동 테스트 — 외부 yolo11 FastAPI(plate_server.py) 호출 계층.
// 실제 서버는 torch/paddleocr/best.pt 가 필요하므로, 같은 계약의 목 서버로 고정한다.
import { describe, it, expect, afterEach } from 'vitest';
import { startPlateServerMock } from '../fixtures/plateServerMock.js';
import { plateRecognize, plateHealth } from '../../server/plateRecognize.js';

const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let running = [];
afterEach(() => { running.splice(0).forEach((s) => s.close()); });

async function mock(opts) {
  const { server, baseUrl } = await startPlateServerMock(opts);
  running.push(server);
  return baseUrl;
}

describe('번호판 인식 — 외부 파이프라인 호출', () => {
  it('인식 결과를 camelCase 로 정규화해 돌려준다', async () => {
    const baseUrl = await mock();
    const r = await plateRecognize({ image: PNG_1X1, baseUrl, minConfidence: 0 });

    expect(r.simulated).toBe(false);
    expect(r.count).toBe(2);
    expect(r.processMs).toBe(183.4);
    expect(r.frameSize).toEqual([1920, 1080]);
    expect(r.plates[0]).toEqual({
      plate: '01나8060',
      confidence: 0.94,
      bbox: [120, 340, 260, 390],
      vehicleBbox: [80, 200, 520, 520],   // vehicle_bbox → vehicleBbox
      isAlert: false,                      // is_alert → isAlert
    });
    expect(r.plates[1].isAlert).toBe(true);
  });

  it('신뢰도 미만은 걸러낸다', async () => {
    const baseUrl = await mock();
    const r = await plateRecognize({ image: PNG_1X1, baseUrl, minConfidence: 0.5 });
    expect(r.count).toBe(1);
    expect(r.plates[0].plate).toBe('01나8060');
  });

  it('서버가 없으면 던지지 않고 시뮬레이션으로 떨어진다', async () => {
    // 아무도 듣지 않는 포트
    const r = await plateRecognize({ image: PNG_1X1, baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 });
    expect(r.simulated).toBe(true);
    expect(r.plates).toEqual([]);
    expect(r.note).toMatch(/plate_server\.py/);
  });

  it('엔진 초기화 중(503)이면 이유를 남기고 시뮬레이션', async () => {
    const baseUrl = await mock({ ready: false });
    const r = await plateRecognize({ image: PNG_1X1, baseUrl });
    expect(r.simulated).toBe(true);
    expect(r.note).toMatch(/초기화/);
  });

  it('서버 오류(500)는 error 로 표시한다', async () => {
    const baseUrl = await mock({ status: 500 });
    const r = await plateRecognize({ image: PNG_1X1, baseUrl });
    expect(r.error).toBe(true);
    expect(r.status).toBe(500);
  });

  it('이미지가 잘못되면 호출 전에 막는다', async () => {
    const baseUrl = await mock();
    const r = await plateRecognize({ image: 'C:/없는폴더/x.png', baseUrl });
    expect(r.simulated).toBe(true);
    expect(r.error).toMatch(/찾을 수 없습니다/);
  });

  it('health 로 서버·엔진 준비 상태를 구분한다', async () => {
    expect(await plateHealth({ baseUrl: await mock({ ready: true }) }))
      .toMatchObject({ reachable: true, ready: true });
    expect(await plateHealth({ baseUrl: await mock({ ready: false }) }))
      .toMatchObject({ reachable: true, ready: false });
    expect(await plateHealth({ baseUrl: 'http://127.0.0.1:1' }))
      .toMatchObject({ reachable: false, ready: false });
  });
});
