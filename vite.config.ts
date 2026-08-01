import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
  plugins: [react(), cloudflare()],
  server: {
    // ヘッドレスマシンのためLAN公開（スマホ等から確認）。ポートは他プロジェクトと被らない専用値
    host: '0.0.0.0',
    port: 7642,
    strictPort: true,
  },
});
