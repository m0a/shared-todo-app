import { useEffect, useState } from 'react';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { hc } from 'hono/client';
import type { AppType } from '../worker/index';

const api = hc<AppType>('/');

interface Me {
  id: string;
  displayName: string;
}

interface ListRow {
  id: string;
  shareToken: string;
  title: string;
}

export function Home() {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined=読込中
  const [myLists, setMyLists] = useState<ListRow[]>([]);
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    const res = await api.api.auth.me.$get();
    const { user } = await res.json();
    setMe(user);
    if (user) {
      const listsRes = await api.api.lists.$get();
      if (listsRes.ok) setMyLists((await listsRes.json()).lists);
    }
  }

  async function handleRegister() {
    const displayName = name.trim();
    if (!displayName || busy) return;
    setBusy(true);
    setError('');
    try {
      const optRes = await api.api.auth.register.options.$post({ json: { displayName } });
      const options = await optRes.json();
      const attResp = await startRegistration({ optionsJSON: options as never });
      const verifyRes = await fetch('/api/auth/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(attResp),
      });
      if (!verifyRes.ok) throw new Error('登録の検証に失敗しました');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '登録に失敗しました');
      console.error(e);
    } finally {
      setBusy(false);
    }
  }

  async function handleLogin() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const optRes = await api.api.auth.login.options.$post();
      const options = await optRes.json();
      const authResp = await startAuthentication({ optionsJSON: options as never });
      const verifyRes = await fetch('/api/auth/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authResp),
      });
      if (!verifyRes.ok) throw new Error('ログインの検証に失敗しました');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ログインに失敗しました');
      console.error(e);
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate() {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const res = await api.api.lists.$post({ json: { title: t } });
      if (res.ok) {
        const created = await res.json();
        location.href = `/l/${created.shareToken}`;
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(list: ListRow) {
    if (!confirm(`「${list.title}」を削除しますか？この操作は取り消せません。`)) return;
    const res = await api.api.lists[':id'].$delete({ param: { id: list.id } });
    if (res.ok) setMyLists((ls) => ls.filter((l) => l.id !== list.id));
  }

  async function handleCopy(list: ListRow) {
    await navigator.clipboard.writeText(`${location.origin}/l/${list.shareToken}`);
    setCopiedId(list.id);
    setTimeout(() => setCopiedId(null), 1500);
  }

  async function handleLogout() {
    await api.api.auth.logout.$post();
    setMe(null);
    setMyLists([]);
  }

  if (me === undefined) return null; // 読込中

  if (!me) {
    return (
      <div className="container home">
        <h1>Shared Todo</h1>
        <p className="home-sub">家族と共有できる買い物・Todoリスト</p>
        <div className="auth-box">
          <div className="auth-row">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="表示名（例: まこと）"
              autoComplete="username webauthn"
            />
            <button onClick={handleRegister} disabled={busy}>
              パスキーで登録
            </button>
          </div>
          <div className="auth-divider">アカウントがある場合</div>
          <button className="secondary" onClick={handleLogin} disabled={busy}>
            パスキーでログイン
          </button>
          {error && <p className="error-inline">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <header className="list-header">
        <h1>マイリスト</h1>
        <span className="conn-status">
          {me.displayName}・
          <button className="link-btn" onClick={handleLogout}>
            ログアウト
          </button>
        </span>
      </header>

      <div className="add-form">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="新しいリスト名"
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
        />
        <button onClick={handleCreate} disabled={busy} aria-label="作成">
          ＋
        </button>
      </div>

      <ul className="items">
        {myLists.map((list) => (
          <li key={list.id} className="item">
            <a className="item-text list-link" href={`/l/${list.shareToken}`}>
              {list.title}
            </a>
            <button className="copy-btn" onClick={() => handleCopy(list)}>
              {copiedId === list.id ? 'コピー済' : '共有URL'}
            </button>
            <button className="delete-btn" aria-label="削除" onClick={() => handleDelete(list)}>
              ×
            </button>
          </li>
        ))}
      </ul>
      {myLists.length === 0 && <p className="empty-msg">リストがありません。上から作成できます。</p>}
    </div>
  );
}
