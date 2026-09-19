import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 프론트(5173)에서 /api, /webhook 을 백엔드(8787)로 프록시 → 동일 출처로 호출
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/webhook': 'http://localhost:8787',
    },
  },
})
