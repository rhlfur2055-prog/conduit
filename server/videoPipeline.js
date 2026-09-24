// ============================================================
// 영상 파이프라인 위치 — 한 곳에서만 정한다.
//
// Remotion 템플릿 프로젝트는 이 저장소 밖의 별도 프로젝트다.
// 위치는 .env 의 CONDUIT_VIDEO_PIPELINE_DIR 로 지정한다.
// 지정하지 않으면 이 저장소 옆의 ../video-pipeline 을 본다.
// 어느 쪽도 없으면 렌더 노드는 { simulated:true } 로 떨어져서
// 워크플로 자체는 계속 흐른다 (키·외부 프로젝트 없이도 데모 가능).
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PIPELINE_DIR = path.resolve(
  process.env.CONDUIT_VIDEO_PIPELINE_DIR || path.join(HERE, '..', '..', 'video-pipeline'),
);

export const OUT_DIR = path.join(PIPELINE_DIR, 'out');

/** 파이프라인이 실제로 있는지 — 특정 컴포지션 파일까지 확인 가능 */
export function pipelineMissing(componentFile) {
  if (!fs.existsSync(PIPELINE_DIR)) return `영상 파이프라인이 없습니다 (${PIPELINE_DIR})`;
  if (componentFile && !fs.existsSync(path.join(PIPELINE_DIR, 'src', componentFile))) {
    return `영상 파이프라인에 ${componentFile} 이 없습니다 (${PIPELINE_DIR})`;
  }
  return null;
}
