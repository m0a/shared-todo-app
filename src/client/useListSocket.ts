import { useEffect, useRef, useState, useCallback } from 'react';
import { flushSync } from 'react-dom';
import { serverMessageSchema, type ClientMessage, type Item } from '../shared/ws-protocol';

function getAnonId(): string {
  let id = localStorage.getItem('anonId');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('anonId', id);
  }
  return id;
}

export interface ListState {
  title: string;
  items: Item[];
  connected: boolean;
  notFound: boolean;
}

export type ServerOp = Extract<
  ReturnType<typeof serverMessageSchema.parse>,
  { type: 'op' }
>;

export type Op = ServerOp['op'];

// リモート変更をアニメーションさせる（View Transitions対応ブラウザのみ）
function applyWithTransition(updater: () => void, animate: boolean) {
  const d = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (animate && d.startViewTransition) {
    d.startViewTransition(() => {
      flushSync(updater);
    });
  } else {
    updater();
  }
}

export function useListSocket(
  shareToken: string,
  onOp?: (msg: ServerOp, own: boolean) => void,
) {
  const [state, setState] = useState<ListState>({
    title: '',
    items: [],
    connected: false,
    notFound: false,
  });
  const wsRef = useRef<WebSocket | null>(null);
  const revisionRef = useRef(0);
  const onOpRef = useRef(onOp);
  onOpRef.current = onOp;
  // 自分が送った操作のclientOpId（エコーを「自分の操作」と識別するため）
  const sentOpsRef = useRef(new Set<string>());
  const hadSyncRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(
        `${proto}://${location.host}/api/l/${shareToken}/ws?anonId=${getAnonId()}`,
      );
      wsRef.current = ws;

      ws.onopen = () => setState((s) => ({ ...s, connected: true }));

      ws.onmessage = (ev) => {
        const parsed = serverMessageSchema.safeParse(JSON.parse(ev.data as string));
        if (!parsed.success) return;
        const msg = parsed.data;

        if (msg.type === 'sync') {
          revisionRef.current = msg.revision;
          // 初回同期はアニメーションなし、restore等の再同期はアニメーションあり
          applyWithTransition(
            () => setState((s) => ({ ...s, title: msg.title, items: msg.items })),
            hadSyncRef.current,
          );
          hadSyncRef.current = true;
          return;
        }
        if (msg.type === 'error') {
          if (msg.message === 'list not found') setState((s) => ({ ...s, notFound: true }));
          return;
        }
        // op: revision が連続していなければ全量再同期
        if (msg.revision !== revisionRef.current + 1) {
          ws.send(JSON.stringify({ type: 'resync' } satisfies ClientMessage));
          return;
        }
        revisionRef.current = msg.revision;
        const own = msg.clientOpId !== null && sentOpsRef.current.delete(msg.clientOpId);
        // 自分の操作は楽観的更新済みなのでアニメーションしない
        applyWithTransition(() => setState((s) => ({ ...s, items: applyOp(s.items, msg.op) })), !own);
        onOpRef.current?.(msg, own);
      };

      ws.onclose = () => {
        setState((s) => ({ ...s, connected: false }));
        if (!disposed) retryTimer = setTimeout(connect, 2000);
      };
    }

    connect();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      wsRef.current?.close();
    };
  }, [shareToken]);

  const send = useCallback((msg: ClientMessage) => {
    if ('clientOpId' in msg && typeof msg.clientOpId === 'string') {
      sentOpsRef.current.add(msg.clientOpId);
    }
    wsRef.current?.send(JSON.stringify(msg));
  }, []);

  // 楽観的更新: サーバのエコーを待たずに手元へ即反映する（エコーが来ても同じ結果になる）
  const applyLocal = useCallback((op: Op) => {
    setState((s) => ({ ...s, items: applyOp(s.items, op) }));
  }, []);

  return { ...state, send, applyLocal };
}

function applyOp(items: Item[], op: Op): Item[] {
  switch (op.type) {
    case 'add_item':
      return [...items, op.item].sort((a, b) => a.position - b.position);
    case 'update_item':
      return items.map((i) => (i.id === op.itemId ? { ...i, text: op.text } : i));
    case 'delete_item':
      return items.filter((i) => i.id !== op.itemId);
    case 'set_checked':
      return items.map((i) => (i.id === op.itemId ? { ...i, checked: op.checked } : i));
    case 'move_item':
      return items
        .map((i) => (i.id === op.itemId ? { ...i, position: op.position } : i))
        .sort((a, b) => a.position - b.position);
    case 'set_color':
      return items.map((i) => (i.id === op.itemId ? { ...i, color: op.color } : i));
    case 'set_colors': {
      const byId = new Map(op.changes.map((c) => [c.itemId, c.color]));
      return items.map((i) => (byId.has(i.id) ? { ...i, color: byId.get(i.id) ?? null } : i));
    }
    case 'reorder':
      return op.items;
    case 'set_checked_many': {
      const ids = new Set(op.itemIds);
      return items.map((i) => (ids.has(i.id) ? { ...i, checked: op.checked } : i));
    }
  }
}

/** opが影響した項目ID（ハイライト表示用） */
export function affectedItemIds(op: Op): string[] {
  switch (op.type) {
    case 'add_item':
      return [op.item.id];
    case 'update_item':
    case 'set_checked':
    case 'move_item':
    case 'set_color':
      return [op.itemId];
    case 'set_colors':
      return op.changes.map((c) => c.itemId);
    case 'set_checked_many':
      return op.itemIds;
    case 'delete_item':
    case 'reorder':
      return [];
  }
}
