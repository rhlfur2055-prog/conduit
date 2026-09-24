// yolo11 plate_server.py 와 같은 계약을 구현한 목 서버.
// 실제 서버는 torch/paddleocr/best.pt 가 필요해서 테스트에서 띄울 수 없다.
// 계약(경로 · multipart 필드명 · 응답 스키마 · 503/400)만 똑같이 흉내 낸다.
import http from 'node:http';

export function startPlateServerMock({ ready = true, plates = null, status = null } = {}) {
  const server = http.createServer((req, res) => {
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && req.url === '/health') {
      return json(200, { status: ready ? 'ok' : 'starting', ready });
    }

    if (req.method === 'POST' && req.url === '/api/detect') {
      if (!ready) return json(503, { detail: '엔진 초기화 중입니다. error=null' });
      if (status) return json(status, { detail: '강제 오류' });

      // 업로드 본문을 끝까지 읽어야 클라이언트가 막히지 않는다
      let size = 0;
      req.on('data', (c) => { size += c.length; });
      req.on('end', () => {
        const ct = req.headers['content-type'] || '';
        if (!ct.includes('multipart/form-data')) return json(400, { detail: 'multipart 아님' });
        if (size === 0) return json(400, { detail: '빈 파일입니다' });
        json(200, {
          success: true,
          plates: plates ?? [
            { plate: '01나8060', confidence: 0.94, bbox: [120, 340, 260, 390], vehicle_bbox: [80, 200, 520, 520], is_alert: false },
            { plate: '12가3456', confidence: 0.41, bbox: [600, 300, 720, 345], vehicle_bbox: [560, 180, 900, 500], is_alert: true },
          ],
          process_ms: 183.4,
          frame_size: [1920, 1080],
        });
      });
      return undefined;
    }

    return json(404, { detail: 'not found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}
