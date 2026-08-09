import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
  plugins: [react(), cloudflare()],
  server: {
    // ヘッドレスマシンで動かすので全インターフェースで待受け、VPN経由でスマホから開く。
    // ポートは他プロジェクトと被らない専用値にしてある
    host: '0.0.0.0',
    port: 7642,
    strictPort: true,
    allowedHosts: ['.ts.net'],
  },
});
