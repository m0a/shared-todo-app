import { useState, type FormEvent } from 'react';
import { hc } from 'hono/client';
import type { AppType } from '../worker/index';

const api = hc<AppType>('/');

export function Home() {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const res = await api.api.dev.lists.$post({ json: { title: t } });
      if (res.ok) {
        const { shareToken } = await res.json();
        location.href = `/l/${shareToken}`;
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container home">
      <h1>Shared Todo</h1>
      <form onSubmit={handleCreate}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="リスト名（例: 買い物リスト）"
        />
        <button type="submit" disabled={busy}>
          作成
        </button>
      </form>
    </div>
  );
}
