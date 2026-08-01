import { useEffect, useRef, useState, useCallback } from 'react';
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

export function useListSocket(
  shareToken: string,
  onOp?: (msg: ServerOp) => void,
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
          setState((s) => ({ ...s, title: msg.title, items: msg.items }));
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
        setState((s) => ({ ...s, items: applyOp(s.items, msg.op) }));
        onOpRef.current?.(msg);
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
    wsRef.current?.send(JSON.stringify(msg));
  }, []);

  return { ...state, send };
}

type Op = Extract<
  ReturnType<typeof serverMessageSchema.parse>,
  { type: 'op' }
>['op'];

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
  }
}
