import { useEffect, useRef, useState } from 'react';
import { hc } from 'hono/client';
import type { AppType } from '../worker/index';
import { useListSocket } from './useListSocket';
import type { Item, ClientMessage } from '../shared/ws-protocol';

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
  const text = typeof detail.text === 'string' && detail.text !== '' ? `「${detail.text}」` : '項目';
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

/**
 * Keep風のインライン編集行。
 * - 常時編集可能。入力はデバウンスして同期、blur/Enterで確定
 * - フォーカス中はリモート更新で手元の編集を上書きしない
 */
function ItemRow({
  item,
  send,
  onEnter,
  onBackspaceEmpty,
  focusRequested,
  onFocused,
}: {
  item: Item;
  send: (msg: ClientMessage) => void;
  onEnter: (item: Item) => void;
  onBackspaceEmpty: (item: Item) => void;
  focusRequested: boolean;
  onFocused: () => void;
}) {
  const [draft, setDraft] = useState(item.text);
  const focusedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // 非フォーカス時はリモートのテキストに追従する
  useEffect(() => {
    if (!focusedRef.current) setDraft(item.text);
  }, [item.text]);

  useEffect(() => {
    if (focusRequested && inputRef.current) {
      inputRef.current.focus();
      onFocused();
    }
  }, [focusRequested, onFocused]);

  function commit() {
    clearTimeout(timerRef.current);
    if (draftRef.current !== item.text) {
      send({ type: 'update_item', itemId: item.id, text: draftRef.current, clientOpId: crypto.randomUUID() });
    }
  }

  function handleChange(value: string) {
    setDraft(value);
    // ライブ同期（デバウンス400ms）
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (draftRef.current !== item.text) {
        send({ type: 'update_item', itemId: item.id, text: draftRef.current, clientOpId: crypto.randomUUID() });
      }
    }, 400);
  }

  return (
    <li className={`item${item.checked ? ' checked' : ''}`}>
      <input
        type="checkbox"
        checked={item.checked}
        onChange={(e) =>
          send({ type: 'set_checked', itemId: item.id, checked: e.target.checked, clientOpId: crypto.randomUUID() })
        }
      />
      <input
        ref={inputRef}
        className="item-input"
        value={draft}
        placeholder=""
        enterKeyHint="enter"
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onBlur={() => {
          focusedRef.current = false;
          commit();
          // 空のまま離れた行は消す（Keepと同じ掃除）
          if (draftRef.current === '') onBackspaceEmpty(item);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
            onEnter(item);
          } else if (e.key === 'Backspace' && draftRef.current === '') {
            e.preventDefault();
            onBackspaceEmpty(item);
          } else if (e.key === 'Escape') {
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
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

export function ListPage({ shareToken }: { shareToken: string }) {
  const [focusId, setFocusId] = useState<string | null>(null);
  const pendingFocusOpRef = useRef<string | null>(null);

  const { title, items, connected, notFound, send } = useListSocket(shareToken, (msg) => {
    // 自分が「Enterで行追加」した項目のエコーが来たらフォーカスを移す
    if (msg.op.type === 'add_item' && msg.clientOpId && msg.clientOpId === pendingFocusOpRef.current) {
      pendingFocusOpRef.current = null;
      setFocusId(msg.op.item.id);
    }
  });

  const [isOwner, setIsOwner] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<RevisionRow[]>([]);

  useEffect(() => {
    api.api.l[':shareToken']
      .$get({ param: { shareToken } })
      .then(async (res) => {
        if (res.ok) setIsOwner((await res.json()).isOwner);
      })
      .catch(() => {});
  }, [shareToken]);

  if (notFound) {
    return <p className="error-msg">リストが見つかりません。URLを確認してください。</p>;
  }

  const unchecked = items.filter((i) => !i.checked);
  const checked = items.filter((i) => i.checked);

  function addAfter(item: Item | null) {
    const clientOpId = crypto.randomUUID();
    pendingFocusOpRef.current = clientOpId;
    send({ type: 'add_item', text: '', ...(item ? { afterId: item.id } : {}), clientOpId });
  }

  function deleteAndFocusPrev(item: Item) {
    const idx = unchecked.findIndex((i) => i.id === item.id);
    const prev = idx > 0 ? unchecked[idx - 1] : null;
    send({ type: 'delete_item', itemId: item.id, clientOpId: crypto.randomUUID() });
    if (prev) setFocusId(prev.id);
  }

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

  function renderRow(item: Item) {
    return (
      <ItemRow
        key={item.id}
        item={item}
        send={send}
        onEnter={(it) => addAfter(it)}
        onBackspaceEmpty={(it) => deleteAndFocusPrev(it)}
        focusRequested={focusId === item.id}
        onFocused={() => setFocusId(null)}
      />
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

      <ul className="items">{unchecked.map(renderRow)}</ul>

      <button className="add-row" onClick={() => addAfter(unchecked.at(-1) ?? null)}>
        ＋ リストに追加
      </button>

      {checked.length > 0 && (
        <section className="checked-section">
          <p className="section-label">チェック済み {checked.length}件</p>
          <ul className="items">{checked.map(renderRow)}</ul>
        </section>
      )}
    </div>
  );
}
