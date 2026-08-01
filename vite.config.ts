import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
  plugins: [react(), cloudflare()],
  server: {
    // ヘッドレスマシンのため全インターフェースで待受け、Tailscale経由でアクセスする
    // (http://beelink-arch.tail4459c9.ts.net:7642)。ポートは他プロジェクトと被らない専用値
    host: '0.0.0.0',
    port: 7642,
    strictPort: true,
    allowedHosts: ['.ts.net'],
  },
});
