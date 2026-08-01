import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
  plugins: [react(), cloudflare()],
  server: {
    // 他プロジェクトのdevサーバ(5173等)と被らない専用ポート
    port: 7642,
    strictPort: true,
  },
});
