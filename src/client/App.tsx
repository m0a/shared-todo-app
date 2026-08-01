import { useEffect, useState } from 'react';
import { hc } from 'hono/client';
import type { AppType } from '../worker/index';

const api = hc<AppType>('/');

export function App() {
  const [healthy, setHealthy] = useState<boolean | null>(null);

  useEffect(() => {
    api.api.health
      .$get()
      .then((res) => res.json())
      .then((data) => setHealthy(data.ok))
      .catch(() => setHealthy(false));
  }, []);

  return (
    <main>
      <h1>Shared Todo</h1>
      <p>API: {healthy === null ? '確認中…' : healthy ? 'OK' : 'NG'}</p>
    </main>
  );
}
