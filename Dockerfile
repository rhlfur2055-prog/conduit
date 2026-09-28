# ============================================================
# Conduit — 멀티스테이지 빌드
#   stage 1: 프론트엔드(Vite) 빌드 → dist/
#   stage 2: 서버 의존성만 설치하고 dist 를 함께 서빙 (단일 컨테이너)
# ============================================================

# ---------- stage 1: 프론트엔드 빌드 ----------
FROM node:24-alpine AS frontend
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build


# ---------- stage 2: 런타임 ----------
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8787

# 서버 의존성 (프로덕션만)
COPY server/package*.json ./server/
RUN cd server && npm install --omit=dev && npm cache clean --force

# 실행 엔진은 프론트/백엔드 공용 → src 도 필요
COPY server ./server
COPY src ./src
COPY --from=frontend /app/dist ./dist

# 데이터 디렉터리(워크플로·크리덴셜·실행기록·DLQ) — 볼륨 마운트 지점
RUN mkdir -p /app/server/data && chown -R node:node /app

USER node
EXPOSE 8787

# 헬스체크: /api/health 가 200 이어야 healthy
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
