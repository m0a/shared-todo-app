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

interface TokenRow {
  id: string;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export function Home() {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined=読込中
  const [myLists, setMyLists] = useState<ListRow[]>([]);
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [mcpClient, setMcpClient] = useState<'claude-code' | 'gemini-cli' | 'json'>('claude-code');

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
      const tokensRes = await api.api.tokens.$get();
      if (tokensRes.ok) setTokens((await tokensRes.json()).tokens);
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

  async function handleIssueToken() {
    const label = prompt('トークンの用途（例: Claude Code）');
    if (!label?.trim()) return;
    const res = await api.api.tokens.$post({ json: { label: label.trim() } });
    if (res.ok) {
      setIssuedToken((await res.json()).token);
      const tokensRes = await api.api.tokens.$get();
      if (tokensRes.ok) setTokens((await tokensRes.json()).tokens);
    }
  }

  async function handleRevokeToken(t: TokenRow) {
    if (!confirm(`トークン「${t.label ?? t.id}」を無効化しますか？このトークンを使うMCPは動かなくなります。`)) return;
    const res = await api.api.tokens[':id'].$delete({ param: { id: t.id } });
    if (res.ok) setTokens((ts) => ts.filter((x) => x.id !== t.id));
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

      <section className="mcp-section">
        <button className="copy-btn" onClick={handleIssueToken}>
          MCPトークン発行
        </button>
        {tokens.length > 0 && (
          <ul className="token-list">
            {tokens.map((t) => (
              <li key={t.id} className="token-row">
                <div className="history-main">
                  <span className="history-desc">{t.label ?? '(無題)'}</span>
                  <span className="history-meta">
                    発行 {new Date(t.createdAt).toLocaleDateString('ja-JP')}・最終使用{' '}
                    {t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleDateString('ja-JP') : 'なし'}
                  </span>
                </div>
                <button className="copy-btn danger" onClick={() => handleRevokeToken(t)}>
                  無効化
                </button>
              </li>
            ))}
          </ul>
        )}
        {issuedToken && (
          <div className="token-box">
            <p>このトークンは今回しか表示されません。使うツールを選んで、設定をコピーしてください（タップでコピー）。</p>
            <div className="client-tabs">
              {(
                [
                  ['claude-code', 'Claude Code'],
                  ['gemini-cli', 'Gemini CLI'],
                  ['json', 'JSON設定（Cursor等）'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  className={`copy-btn${mcpClient === key ? ' active' : ''}`}
                  onClick={() => setMcpClient(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            <code onClick={(e) => navigator.clipboard.writeText((e.target as HTMLElement).textContent ?? '')}>
              {mcpClient === 'claude-code' &&
                `claude mcp add --scope user --transport http shared-todo ${location.origin}/api/mcp --header "Authorization: Bearer ${issuedToken}"`}
              {mcpClient === 'gemini-cli' &&
                `gemini mcp add --transport http --header "Authorization: Bearer ${issuedToken}" shared-todo ${location.origin}/api/mcp`}
              {mcpClient === 'json' &&
                JSON.stringify(
                  {
                    mcpServers: {
                      'shared-todo': {
                        type: 'http',
                        url: `${location.origin}/api/mcp`,
                        headers: { Authorization: `Bearer ${issuedToken}` },
                      },
                    },
                  },
                  null,
                  2,
                )}
            </code>
            {mcpClient === 'json' && (
              <p className="history-meta">
                Cursor / VS Code / Claude Desktop など、mcpServers 形式の設定ファイルを使うツール向け。キー名はツールのドキュメントに合わせて調整してください。
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
