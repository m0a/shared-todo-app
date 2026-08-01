import { useEffect, useState, type FormEvent } from 'react';
import { hc } from 'hono/client';
import type { AppType } from '../worker/index';
import { useListSocket } from './useListSocket';
import type { Item } from '../shared/ws-protocol';

const api = hc<AppType>('/');

interface RevisionRow {
  seq: number;
  opType: string;
  opDetail: string | null;
  actorType: string;
  actorName: string | null;
  createdAt: number;
}

function describeOp(rev: RevisionRow): string {
  const detail = rev.opDetail ? (JSON.parse(rev.opDetail) as Record<string, unknown>) : {};
  const text = typeof detail.text === 'string' ? `「${detail.text}」` : '';
  switch (rev.opType) {
    case 'add_item':
      return `${text}を追加`;
    case 'update_item':
      return `${text}に変更`;
    case 'delete_item':
      return `${text}を削除`;
    case 'set_checked':
      return `${text}を${detail.checked ? 'チェック' : 'チェック解除'}`;
    case 'move_item':
      return '並び替え';
    case 'restore':
      return `世代${detail.restoredFrom}へ復元`;
    default:
      return rev.opType;
  }
}

function actorLabel(rev: RevisionRow): string {
  if (rev.actorType === 'ai') return 'AI';
  return rev.actorName ?? (rev.actorType === 'owner' ? '作成者' : 'ゲスト');
}

export function ListPage({ shareToken }: { shareToken: string }) {
  const { title, items, connected, notFound, send } = useListSocket(shareToken);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [isOwner, setIsOwner] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<RevisionRow[]>([]);

  useEffect(() => {
    api.api.l[':shareToken']
      .$get({ param: { shareToken } })
      .then(async (res) => {
        if (res.ok) {
          const meta = await res.json();
          setIsOwner(meta.isOwner);
        }
      })
      .catch(() => {});
  }, [shareToken]);

  async function openHistory() {
    const res = await api.api.l[':shareToken'].revisions.$get({ param: { shareToken } });
    if (res.ok) {
      setHistory((await res.json()).revisions);
      setShowHistory(true);
    }
  }

  async function handleRestore(seq: number) {
    if (!confirm(`世代${seq}の状態に戻しますか？`)) return;
    await api.api.l[':shareToken'].restore.$post({ param: { shareToken }, json: { seq } });
    setShowHistory(false);
  }

  if (notFound) {
    return <p className="error-msg">リストが見つかりません。URLを確認してください。</p>;
  }

  const unchecked = items.filter((i) => !i.checked);
  const checked = items.filter((i) => i.checked);

  function handleAdd(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    send({ type: 'add_item', text, clientOpId: crypto.randomUUID() });
    setDraft('');
  }

  function startEdit(item: Item) {
    setEditingId(item.id);
    setEditDraft(item.text);
  }

  function commitEdit() {
    if (editingId === null) return;
    const text = editDraft.trim();
    const original = items.find((i) => i.id === editingId);
    if (text && original && text !== original.text) {
      send({ type: 'update_item', itemId: editingId, text, clientOpId: crypto.randomUUID() });
    }
    setEditingId(null);
  }

  function renderItem(item: Item) {
    return (
      <li key={item.id} className={`item${item.checked ? ' checked' : ''}`}>
        <input
          type="checkbox"
          checked={item.checked}
          onChange={(e) =>
            send({
              type: 'set_checked',
              itemId: item.id,
              checked: e.target.checked,
              clientOpId: crypto.randomUUID(),
            })
          }
        />
        {editingId === item.id ? (
          <input
            className="item-edit"
            value={editDraft}
            autoFocus
            onChange={(e) => setEditDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitEdit();
              if (e.key === 'Escape') setEditingId(null);
            }}
          />
        ) : (
          <span className="item-text" onClick={() => startEdit(item)}>
            {item.text}
          </span>
        )}
        <button
          className="delete-btn"
          aria-label="削除"
          onClick={() => send({ type: 'delete_item', itemId: item.id, clientOpId: crypto.randomUUID() })}
        >
          ×
        </button>
      </li>
    );
  }

  return (
    <div className="container">
      <header className="list-header">
        <h1>{title || '…'}</h1>
        <span className={`conn-status${connected ? '' : ' offline'}`}>
          {isOwner && (
            <button className="link-btn" onClick={openHistory}>
              履歴
            </button>
          )}
          {isOwner && '・'}
          {connected ? '同期中' : '再接続中…'}
        </span>
      </header>

      {showHistory && (
        <div className="history-overlay" onClick={() => setShowHistory(false)}>
          <div className="history-panel" onClick={(e) => e.stopPropagation()}>
            <div className="history-header">
              <h2>変更履歴</h2>
              <button className="delete-btn" onClick={() => setShowHistory(false)}>
                ×
              </button>
            </div>
            <ul className="history-list">
              {history.map((rev) => (
                <li key={rev.seq} className="history-row">
                  <div className="history-main">
                    <span className="history-desc">{describeOp(rev)}</span>
                    <span className="history-meta">
                      {actorLabel(rev)}・
                      {new Date(rev.createdAt).toLocaleString('ja-JP', {
                        month: 'numeric',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <button className="copy-btn" onClick={() => handleRestore(rev.seq)}>
                    復元
                  </button>
                </li>
              ))}
              {history.length === 0 && <p className="empty-msg">履歴がありません</p>}
            </ul>
          </div>
        </div>
      )}

      <form className="add-form" onSubmit={handleAdd}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="項目を追加"
          enterKeyHint="done"
        />
        <button type="submit" aria-label="追加">
          ＋
        </button>
      </form>

      <ul className="items">{unchecked.map(renderItem)}</ul>

      {checked.length > 0 && (
        <section className="checked-section">
          <p className="section-label">チェック済み {checked.length}件</p>
          <ul className="items">{checked.map(renderItem)}</ul>
        </section>
      )}
    </div>
  );
}
