import { useEffect, useRef, useState } from 'react';
import { hc } from 'hono/client';
import type { AppType } from '../worker/index';
import { useListSocket, affectedItemIds, applyWithTransition } from './useListSocket';
import { ITEM_COLORS, type ItemColor, type Item, type ClientMessage } from '../shared/ws-protocol';

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
      return `${text}をゴミ箱へ`;
    case 'restore_item':
      return `${text}をゴミ箱から復元`;
    case 'set_checked':
      return `${text}を${detail.checked ? 'チェック' : 'チェック解除'}`;
    case 'move_item':
      return '並び替え';
    case 'set_color':
      return `${text}の色を変更`;
    case 'set_colors':
      return `${detail.count}件の色を変更`;
    case 'set_checked_many':
      return `${detail.count}件を${detail.checked ? 'チェック' : 'チェック解除'}`;
    case 'reorder':
      return '一括並べ替え';
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
  onDragHandleDown,
  dragging,
  flashed,
  rowRef,
}: {
  item: Item;
  send: (msg: ClientMessage) => void;
  onEnter: (item: Item) => void;
  onBackspaceEmpty: (item: Item) => void;
  focusRequested: boolean;
  onFocused: () => void;
  onDragHandleDown?: (item: Item, e: React.PointerEvent) => void;
  dragging?: boolean;
  flashed?: boolean;
  rowRef?: (el: HTMLLIElement | null) => void;
}) {
  const [draft, setDraft] = useState(item.text);
  const [showPalette, setShowPalette] = useState(false);
  const focusedRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
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

  // 折り返した行数に合わせて高さを追従させる
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

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

  const style: React.CSSProperties = {
    // View Transitionsで行ごとに移動アニメーションさせるための一意な名前
    viewTransitionName: `i-${item.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
    ...(item.color
      ? { borderLeft: `5px solid ${ITEM_COLORS[item.color]}`, background: `${ITEM_COLORS[item.color]}22` }
      : {}),
  };

  return (
    <li
      ref={rowRef}
      style={style}
      className={`item${item.checked ? ' checked' : ''}${dragging ? ' dragging' : ''}${flashed ? ' flash' : ''}`}
    >
      {onDragHandleDown && (
        <span className="drag-handle" onPointerDown={(e) => onDragHandleDown(item, e)}>
          ⠿
        </span>
      )}
      <input
        type="checkbox"
        checked={item.checked}
        onChange={(e) =>
          send({ type: 'set_checked', itemId: item.id, checked: e.target.checked, clientOpId: crypto.randomUUID() })
        }
      />
      <textarea
        ref={inputRef}
        className="item-input"
        rows={1}
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
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
      />
      <button
        className="color-btn"
        aria-label="色を変更"
        style={item.color ? { background: ITEM_COLORS[item.color] } : undefined}
        onClick={() => setShowPalette((v) => !v)}
      />
      <button
        className="delete-btn"
        aria-label="削除"
        onClick={() => send({ type: 'delete_item', itemId: item.id, clientOpId: crypto.randomUUID() })}
      >
        ×
      </button>
      {showPalette && (
        <div className="palette" onClick={(e) => e.stopPropagation()}>
          <button
            className="palette-swatch none"
            aria-label="色なし"
            onClick={() => {
              send({ type: 'set_color', itemId: item.id, color: null, clientOpId: crypto.randomUUID() });
              setShowPalette(false);
            }}
          >
            ×
          </button>
          {(Object.keys(ITEM_COLORS) as ItemColor[]).map((name) => (
            <button
              key={name}
              className="palette-swatch"
              aria-label={name}
              style={{ background: ITEM_COLORS[name] }}
              onClick={() => {
                send({ type: 'set_color', itemId: item.id, color: name, clientOpId: crypto.randomUUID() });
                setShowPalette(false);
              }}
            />
          ))}
        </div>
      )}
    </li>
  );
}

export function ListPage({ shareToken }: { shareToken: string }) {
  const [focusId, setFocusId] = useState<string | null>(null);
  const pendingFocusOpRef = useRef<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const dragOrderRef = useRef<string[] | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  const [flashIds, setFlashIds] = useState<ReadonlySet<string>>(new Set());

  // チェックON/OFFの直後は3秒間その場にとどめてから移動する（同期自体は即時）。
  // holds: id → 変更後もとどまって描画される側（'unchecked'=上のリスト / 'checked'=チェック済みセクション）
  const CHECK_MOVE_DELAY_MS = 3000;
  const [holds, setHolds] = useState<ReadonlyMap<string, 'unchecked' | 'checked'>>(new Map());
  const holdTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  function onCheckedChange(ids: string[], nowChecked: boolean) {
    // ONにした→しばらく上に留まる / OFFにした→しばらく下に留まる
    const keepArea = nowChecked ? 'unchecked' : 'checked';
    const oppositeHold = nowChecked ? 'checked' : 'unchecked';
    setHolds((prev) => {
      const next = new Map(prev);
      for (const id of ids) {
        clearTimeout(holdTimersRef.current.get(id));
        holdTimersRef.current.delete(id);
        if (next.get(id) === oppositeHold) {
          // 保留中に元へ戻された → 保留解除だけ（その場に留まる）
          next.delete(id);
        } else {
          next.set(id, keepArea);
          holdTimersRef.current.set(
            id,
            setTimeout(() => {
              holdTimersRef.current.delete(id);
              // 移動はView Transitionsで滑らかに
              applyWithTransition(() => {
                setHolds((p) => {
                  const n = new Map(p);
                  n.delete(id);
                  return n;
                });
              }, true);
            }, CHECK_MOVE_DELAY_MS),
          );
        }
      }
      return next;
    });
  }

  const { title, items, connected, notFound, send, applyLocal } = useListSocket(shareToken, (msg, own) => {
    // 何か操作が届いた＝リストが更新された
    setUpdatedAt(Date.now());
    // リモートのチェックON/OFFも同じく3秒とどめてから移動
    if (!own && msg.op.type === 'set_checked') {
      onCheckedChange([msg.op.itemId], msg.op.checked);
    } else if (!own && msg.op.type === 'set_checked_many') {
      onCheckedChange(msg.op.itemIds, msg.op.checked);
    }
    // 他の人・AIの変更は該当行を一瞬ハイライトして分かるようにする
    if (!own) {
      const ids = affectedItemIds(msg.op);
      if (ids.length > 0) {
        setFlashIds((prev) => new Set([...prev, ...ids]));
        setTimeout(() => {
          setFlashIds((prev) => {
            const next = new Set(prev);
            for (const id of ids) next.delete(id);
            return next;
          });
        }, 1300);
      }
    }
    // 自分が「Enterで行追加」した項目のエコーが来たらフォーカスを移す
    if (msg.op.type === 'add_item' && msg.clientOpId && msg.clientOpId === pendingFocusOpRef.current) {
      pendingFocusOpRef.current = null;
      setFocusId(msg.op.item.id);
    }
  });

  const [isOwner, setIsOwner] = useState(false);
  const [loggedIn, setLoggedIn] = useState(true); // 判明するまでバナーは出さない
  const [showTrash, setShowTrash] = useState(false);
  const [trash, setTrash] = useState<{ id: string; text: string; deletedAt: number | null }[]>([]);
  const [createdAt, setCreatedAt] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<RevisionRow[]>([]);

  useEffect(() => {
    api.api.l[':shareToken']
      .$get({ param: { shareToken } })
      .then(async (res) => {
        if (res.ok) {
          const meta = await res.json();
          setIsOwner(meta.isOwner);
          setCreatedAt(meta.createdAt);
          setUpdatedAt(meta.updatedAt);
        }
      })
      .catch(() => {});
    api.api.auth.me
      .$get()
      .then(async (res) => {
        if (res.ok) setLoggedIn((await res.json()).user !== null);
      })
      .catch(() => {});
  }, [shareToken]);

  if (notFound) {
    return <p className="error-msg">リストが見つかりません。URLを確認してください。</p>;
  }

  // チェック状態が変わっても保留中は元のセクションにとどめて描画する
  const uncheckedRaw = items.filter(
    (i) => holds.get(i.id) === 'unchecked' || (!i.checked && holds.get(i.id) !== 'checked'),
  );
  // ドラッグ中はローカルの並び順で描画する
  const unchecked = dragOrder
    ? [...uncheckedRaw].sort((a, b) => dragOrder.indexOf(a.id) - dragOrder.indexOf(b.id))
    : uncheckedRaw;
  const checked = items.filter(
    (i) => holds.get(i.id) === 'checked' || (i.checked && holds.get(i.id) !== 'unchecked'),
  );

  function startDrag(item: Item, e: React.PointerEvent) {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const initial = uncheckedRaw.map((i) => i.id);
    dragOrderRef.current = initial;
    setDragOrder(initial);
    setDragId(item.id);

    const move = (ev: PointerEvent) => {
      const prev = dragOrderRef.current;
      if (!prev) return;
      const others = prev.filter((id) => id !== item.id);
      let idx = others.length;
      for (let k = 0; k < others.length; k++) {
        const el = rowRefs.current.get(others[k]!);
        if (el) {
          const r = el.getBoundingClientRect();
          if (ev.clientY < r.top + r.height / 2) {
            idx = k;
            break;
          }
        }
      }
      const next = [...others];
      next.splice(idx, 0, item.id);
      dragOrderRef.current = next;
      setDragOrder(next);
    };

    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const order = dragOrderRef.current;
      if (order) {
        const idx = order.indexOf(item.id);
        const byId = new Map(uncheckedRaw.map((i) => [i.id, i]));
        const prevItem = idx > 0 ? byId.get(order[idx - 1]!) : undefined;
        const nextItem = idx < order.length - 1 ? byId.get(order[idx + 1]!) : undefined;
        let position: number | null = null;
        if (prevItem && nextItem) position = (prevItem.position + nextItem.position) / 2;
        else if (prevItem) position = prevItem.position + 1;
        else if (nextItem) position = nextItem.position - 1;
        if (position !== null && position !== item.position) {
          // ドロップした位置に即時反映してからサーバへ送る（戻ってから直る、を防ぐ）
          applyLocal({ type: 'move_item', itemId: item.id, position });
          send({ type: 'move_item', itemId: item.id, position, clientOpId: crypto.randomUUID() });
        }
      }
      dragOrderRef.current = null;
      setDragOrder(null);
      setDragId(null);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  async function handleShare() {
    const url = location.href;
    if (navigator.share) {
      try {
        await navigator.share({ title, text: title, url });
      } catch {
        // ユーザーキャンセルは無視
      }
    } else {
      // Web Share API非対応環境はLINEの共有URLへ
      open(`https://line.me/R/share?text=${encodeURIComponent(`${title}\n${url}`)}`, '_blank');
    }
  }

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

  async function openTrash() {
    const res = await api.api.l[':shareToken'].trash.$get({ param: { shareToken } });
    if (res.ok) {
      setTrash((await res.json()).items);
      setShowTrash(true);
    }
  }

  function handleTrashRestore(id: string) {
    send({ type: 'restore_item', itemId: id, clientOpId: crypto.randomUUID() });
    setTrash((t) => t.filter((x) => x.id !== id));
  }

  async function handleRestore(seq: number) {
    if (!confirm(`世代${seq}の状態に戻しますか？`)) return;
    await api.api.l[':shareToken'].restore.$post({ param: { shareToken }, json: { seq } });
    setShowHistory(false);
  }

  // チェック・削除・色変更はエコーを待たず手元に即反映してから送る
  function sendOptimistic(msg: ClientMessage) {
    if (msg.type === 'set_checked') {
      applyLocal({ type: 'set_checked', itemId: msg.itemId, checked: msg.checked });
      // 同期は即時。表示上の行移動だけ遅らせる
      onCheckedChange([msg.itemId], msg.checked);
    }
    else if (msg.type === 'delete_item') applyLocal({ type: 'delete_item', itemId: msg.itemId });
    else if (msg.type === 'set_color') applyLocal({ type: 'set_color', itemId: msg.itemId, color: msg.color });
    send(msg);
  }

  function renderRow(item: Item, draggable = false) {
    return (
      <ItemRow
        key={item.id}
        item={item}
        send={sendOptimistic}
        onEnter={(it) => addAfter(it)}
        onBackspaceEmpty={(it) => deleteAndFocusPrev(it)}
        focusRequested={focusId === item.id}
        onFocused={() => setFocusId(null)}
        onDragHandleDown={draggable ? startDrag : undefined}
        dragging={dragId === item.id}
        flashed={flashIds.has(item.id)}
        rowRef={(el) => {
          if (el) rowRefs.current.set(item.id, el);
          else rowRefs.current.delete(item.id);
        }}
      />
    );
  }

  return (
    <div className="container">
      <header className="list-header">
        <div className="title-block">
          {isOwner && (
            <a className="back-link" href="/" aria-label="マイリストへ戻る">
              ←
            </a>
          )}
          <div className="title-texts">
            <h1>{title || '…'}</h1>
            {createdAt !== null && (
              <span className="created-at">
                {new Date(createdAt).toLocaleDateString('ja-JP')}作成
                {updatedAt !== null &&
                  `・${new Date(updatedAt).toLocaleString('ja-JP', {
                    month: 'numeric',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}更新`}
              </span>
            )}
          </div>
        </div>
        <span className={`conn-status${connected ? '' : ' offline'}`}>
          <button className="link-btn" onClick={handleShare}>
            共有
          </button>
          ・
          <button className="link-btn" onClick={openTrash}>
            ゴミ箱
          </button>
          ・
          {isOwner && (
            <>
              <button className="link-btn" onClick={openHistory}>
                履歴
              </button>
              ・
            </>
          )}
          {connected ? '同期中' : '再接続中…'}
        </span>
      </header>

      {showTrash && (
        <div className="history-overlay" onClick={() => setShowTrash(false)}>
          <div className="history-panel" onClick={(e) => e.stopPropagation()}>
            <div className="history-header">
              <h2>ゴミ箱</h2>
              <button className="delete-btn" onClick={() => setShowTrash(false)}>
                ×
              </button>
            </div>
            <ul className="history-list">
              {trash.map((t) => (
                <li key={t.id} className="history-row">
                  <div className="history-main">
                    <span className="history-desc">{t.text || '(空の項目)'}</span>
                    <span className="history-meta">
                      {t.deletedAt !== null &&
                        `${new Date(t.deletedAt).toLocaleString('ja-JP', {
                          month: 'numeric',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}に削除`}
                    </span>
                  </div>
                  <button className="copy-btn" onClick={() => handleTrashRestore(t.id)}>
                    復元
                  </button>
                </li>
              ))}
              {trash.length === 0 && <p className="empty-msg">ゴミ箱は空です（30日で自動削除）</p>}
            </ul>
          </div>
        </div>
      )}

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

      <ul className="items">{unchecked.map((i) => renderRow(i, true))}</ul>

      <button className="add-row" onClick={() => addAfter(unchecked.at(-1) ?? null)}>
        ＋ リストに追加
      </button>

      {checked.length > 0 && (
        <section className="checked-section">
          <p className="section-label">チェック済み {checked.length}件</p>
          <ul className="items">{checked.map((i) => renderRow(i))}</ul>
        </section>
      )}

      {!loggedIn && (
        <p className="login-banner">
          <a href="/">ログイン（無料・パスキー）</a>すると、自分のTodoリストを作って共有できます
        </p>
      )}
    </div>
  );
}
