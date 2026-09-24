"""PaddleOCR 줄 인식 서버 — conduit 의 앙상블 OCR(server/ocrEnsemble.js)이 부른다.

    python server/ocr/paddle_ocr_server.py --port 8866

필요: paddlepaddle, paddleocr(3.x), opencv-python, numpy  (Python 3.10~3.13 — paddle 휠이 3.14 에는 없다)

POST /ocr   {"image": "<base64>", "extras": false}
  → {"lines": [{"box": [x, y, w, h],
                "paddle":   {"text", "score"},      PaddleOCR 한국어 인식
                "paddleEn": {"text", "score"},      영문 모델 인식          ← extras 일 때만
                "crops": {"orig", "up2", "up3bin"}   tesseract 가 읽을 줄 이미지 ← extras 일 때만}],
     "size": [w, h], "ms": 123}
GET  /health → {"ok": true}

한국어 인식 모델은 한글은 강하지만 영문 대문자(I→l, W 누락)에 약하고, tesseract 는 그 반대다.
그래서 줄 이미지를 같이 돌려주고, 합치는 일(글자 단위 가중 투표)은 Node 쪽이 한다.
"""
import argparse
import base64
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

import cv2
import numpy as np

os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
from paddleocr import PaddleOCR, TextRecognition  # noqa: E402

# 줄 찾기·자르기·인식은 PaddleOCR 자체 흐름을 그대로 쓴다. 직접 잘라서 인식하면 줄 끝이 잘려
# 정확도가 크게 떨어졌다 (실측: 한 줄 이미지 96.7% → 35%).
# paddle 3.3 + oneDNN 조합은 기본 설정에서 ConvertPirAttribute2RuntimeAttribute 로 죽는다 → 끈다.
# server_det 는 CPU 에서 문서 한 장에 7초, mobile_det 은 1.4초이고 정확도는 같거나 낫다.
PIPE = PaddleOCR(
    lang="korean",
    text_detection_model_name="PP-OCRv5_mobile_det",
    text_recognition_model_name="korean_PP-OCRv5_mobile_rec",
    use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False,
    enable_mkldnn=False,
)
# 한국어 모델은 작은 영문을 잘 못 읽는다 (Invoice → Invie). 영문 전용 모델을 후보로 하나 더 둔다.
REC_EN = TextRecognition(model_name="en_PP-OCRv5_mobile_rec", enable_mkldnn=False)
LOCK = Lock()   # paddle predictor 는 스레드 안전하지 않다

TESS_PAD = 0.35   # tesseract 용 줄 이미지 여백 (줄 높이 대비) — 가장자리에 붙은 글자에 약하다
EN_PAD = 0.1


def png_b64(img):
    ok, buf = cv2.imencode(".png", img)
    return base64.b64encode(buf.tobytes()).decode() if ok else ""


def up(img, k):
    return cv2.resize(img, None, fx=k, fy=k, interpolation=cv2.INTER_LANCZOS4)


def up3bin(img):
    g = cv2.cvtColor(up(img, 3), cv2.COLOR_BGR2GRAY)
    _, b = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return b


def crop(img, box, ratio):
    h, w = img.shape[:2]
    x0, y0, x1, y1 = box
    pad = int((y1 - y0) * ratio) + 2
    c = img[max(0, y0 - pad):min(h, y1 + pad), max(0, x0 - pad):min(w, x1 + pad)]
    return cv2.copyMakeBorder(c, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=(255, 255, 255))


def read(image_bgr, extras=False):
    r = PIPE.predict(image_bgr)[0]
    boxes = []
    for poly in r["rec_polys"]:
        p = np.array(poly)
        x0, y0 = p.min(axis=0)
        x1, y1 = p.max(axis=0)
        boxes.append((int(x0), int(y0), int(x1), int(y1)))
    if not boxes:
        return []
    if not extras:
        # 앙상블이 아니면 영문 모델·줄 이미지는 쓰이지 않는다 — 만들지 않는다 (문서당 3.0초 → 1.x초)
        return [{"box": [b[0], b[1], b[2] - b[0], b[3] - b[1]], "paddle": {"text": t, "score": round(float(sc), 4)}}
                for b, t, sc in zip(boxes, r["rec_texts"], r["rec_scores"])]
    en = [{"text": x["rec_text"], "score": round(float(x["rec_score"]), 4)}
          for x in REC_EN.predict([crop(image_bgr, b, EN_PAD) for b in boxes], batch_size=8)]
    lines = []
    for b, text, score, e in zip(boxes, r["rec_texts"], r["rec_scores"], en):
        c = crop(image_bgr, b, TESS_PAD)
        lines.append({
            "box": [b[0], b[1], b[2] - b[0], b[3] - b[1]],
            "paddle": {"text": text, "score": round(float(score), 4)},
            "paddleEn": e,
            "crops": {"orig": png_b64(c), "up2": png_b64(up(c, 2)), "up3bin": png_b64(up3bin(c))},
        })
    return lines


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/ocr":
            return self._json(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(n) or b"{}")
            raw = base64.b64decode(payload.get("image") or "")
            img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
            if img is None:
                return self._json(400, {"error": "이미지를 해석할 수 없습니다"})
            t0 = time.time()
            with LOCK:
                lines = read(img, extras=bool(payload.get("extras")))
            self._json(200, {"lines": lines, "size": [img.shape[1], img.shape[0]], "ms": round((time.time() - t0) * 1000)})
        except Exception as e:  # noqa: BLE001
            self._json(500, {"error": str(e)})

    def log_message(self, *args):
        pass


def main():
    ap = argparse.ArgumentParser(description="PaddleOCR 줄 인식 서버")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8866)
    a = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    print(f"[paddle-ocr] http://{a.host}:{a.port}  (POST /ocr · GET /health)", flush=True)
    ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
