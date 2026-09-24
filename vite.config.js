import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 프론트(5173)에서 /api, /webhook 을 백엔드(8787)로 프록시 → 동일 출처로 호출
// GitHub Pages 데모(https://<user>.github.io/conduit/)는 하위 경로라 base 가 필요하다 — 배포 워크플로가 VITE_BASE 를 준다
export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [react()],
  test: {
    setupFiles: ['./tests/setup.js'],
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/webhook': 'http://localhost:8787',
    },
  },
})
