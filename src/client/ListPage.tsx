import { useState, type FormEvent } from 'react';
import { useListSocket } from './useListSocket';
import type { Item } from '../shared/ws-protocol';

export function ListPage({ shareToken }: { shareToken: string }) {
  const { title, items, connected, notFound, send } = useListSocket(shareToken);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

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
          {connected ? '同期中' : '再接続中…'}
        </span>
      </header>

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
