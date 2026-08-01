import { DurableObject } from 'cloudflare:workers';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { eq, and, lte, lt, asc, isNull, isNotNull, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { lists, items, revisions, anonProfiles } from '../db/schema';
import {
  clientMessageSchema,
  type ClientMessage,
  type ServerMessage,
  type Item,
  type Actor,
} from '../../shared/ws-protocol';

interface WsAttachment {
  actorType: Actor['type'];
  actorId: string;
  actorName: string | null;
}

const REVISION_KEEP = 500; // 1リストあたり保持する世代数
const TRASH_KEEP_MS = 30 * 24 * 60 * 60 * 1000; // ゴミ箱の保持期間（30日）

/**
 * 1リスト = 1インスタンス。全ミューテーションを直列化し、
 * D1へ書き込んだ後、接続中の全WebSocketへブロードキャストする。
 * WebSocket Hibernation API を使用。
 */
export class ListRoom extends DurableObject<Env> {
  private listId: string | null = null;

  private db(): DrizzleD1Database {
    return drizzle(this.env.DB);
  }

  private async getListId(): Promise<string> {
    if (this.listId) return this.listId;
    const stored = await this.ctx.storage.get<string>('listId');
    if (!stored) throw new Error('listId not initialized');
    this.listId = stored;
    return stored;
  }

  async fetch(request: Request): Promise<Response> {
    // Worker が share_token を解決してから X-List-Id を付けてルーティングしてくる
    const listId = request.headers.get('X-List-Id');
    if (listId && this.listId !== listId) {
      this.listId = listId;
      await this.ctx.storage.put('listId', listId);
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      const attachment: WsAttachment = {
        actorType: (request.headers.get('X-Actor-Type') as Actor['type']) ?? 'anon',
        actorId: request.headers.get('X-Actor-Id') ?? 'unknown',
        actorName: request.headers.get('X-Actor-Name'),
      };
      // 匿名ユーザーは登録済みニックネームがあればそれを使う
      if (attachment.actorType === 'anon' && !attachment.actorName) {
        const [profile] = await this.db()
          .select({ nickname: anonProfiles.nickname })
          .from(anonProfiles)
          .where(
            and(eq(anonProfiles.listId, await this.getListId()), eq(anonProfiles.anonId, attachment.actorId)),
          );
        attachment.actorName = profile?.nickname ?? null;
      }

      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment(attachment);
      // 接続直後に全量同期を送る
      await this.sendSync(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // ---- HTTPエントリ（restore: 作成者のUndo / mutate: MCP等の外部ミューテーション）----
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname.endsWith('/restore')) {
      const { seq, actor } = (await request.json()) as { seq: number; actor: WsAttachment };
      const ok = await this.restore(seq, actor);
      return Response.json(ok ? { ok: true } : { error: 'revision not found' }, {
        status: ok ? 200 : 404,
      });
    }
    if (request.method === 'POST' && url.pathname.endsWith('/mutate')) {
      const { op, actor } = (await request.json()) as { op: unknown; actor: WsAttachment };
      const parsed = clientMessageSchema.safeParse(op);
      if (!parsed.success || parsed.data.type === 'resync' || parsed.data.type === 'set_nickname') {
        return Response.json({ error: 'invalid op' }, { status: 400 });
      }
      await this.applyMutation(parsed.data, actor);
      return Response.json({ ok: true });
    }
    return new Response('Not found', { status: 404 });
  }

  /** 指定世代のスナップショットへ復元し、新しい世代として記録・全員へ再同期 */
  private async restore(seq: number, actor: WsAttachment): Promise<boolean> {
    const db = this.db();
    const listId = await this.getListId();
    const [rev] = await db
      .select({ snapshot: revisions.snapshot })
      .from(revisions)
      .where(and(eq(revisions.listId, listId), eq(revisions.seq, seq)));
    if (!rev) return false;

    const snapshot = JSON.parse(rev.snapshot) as Item[];
    const now = Date.now();
    // アクティブな項目と、スナップショットとIDが重なるゴミ箱内の項目を消してから入れ直す
    await db.delete(items).where(and(eq(items.listId, listId), isNull(items.deletedAt)));
    if (snapshot.length > 0) {
      await db
        .delete(items)
        .where(and(eq(items.listId, listId), inArray(items.id, snapshot.map((i) => i.id))));
    }
    if (snapshot.length > 0) {
      await db.insert(items).values(
        snapshot.map((it) => ({
          id: it.id,
          listId,
          text: it.text,
          checked: it.checked,
          color: it.color ?? null,
          position: it.position,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }

    const [list] = await db
      .select({ currentRevision: lists.currentRevision, title: lists.title })
      .from(lists)
      .where(eq(lists.id, listId));
    const revision = (list?.currentRevision ?? 0) + 1;
    await db.batch([
      db.update(lists).set({ currentRevision: revision, updatedAt: now }).where(eq(lists.id, listId)),
      db.insert(revisions).values({
        listId,
        seq: revision,
        opType: 'restore',
        opDetail: JSON.stringify({ restoredFrom: seq }),
        actorType: actor.actorType,
        actorId: actor.actorId,
        actorName: actor.actorName,
        snapshot: rev.snapshot,
        createdAt: now,
      }),
    ]);

    // 復元は差分でなく全量同期で全クライアントへ配る
    this.broadcast({ type: 'sync', revision, title: list?.title ?? '', items: snapshot });
    return true;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    let json: unknown;
    try {
      json = JSON.parse(message);
    } catch {
      this.send(ws, { type: 'error', message: 'invalid json' });
      return;
    }
    const parsed = clientMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.send(ws, { type: 'error', message: 'invalid message' });
      return;
    }
    const msg = parsed.data;
    const attachment = ws.deserializeAttachment() as WsAttachment;

    try {
      if (msg.type === 'resync') {
        await this.sendSync(ws);
        return;
      }
      if (msg.type === 'set_nickname') {
        await this.setNickname(ws, attachment, msg.nickname);
        return;
      }
      await this.applyMutation(msg, attachment);
    } catch (e) {
      console.error('mutation failed', e);
      this.send(ws, { type: 'error', message: 'operation failed' });
    }
  }

  async webSocketClose(): Promise<void> {
    // hibernation対応: 特別なクリーンアップ不要
  }

  // ---- ミューテーション ----

  private async applyMutation(
    msg: Exclude<ClientMessage, { type: 'resync' } | { type: 'set_nickname' }>,
    attachment: WsAttachment,
  ): Promise<void> {
    const db = this.db();
    const listId = await this.getListId();
    const now = Date.now();

    let op: Extract<ServerMessage, { type: 'op' }>['op'] | null = null;
    let opDetail: Record<string, unknown> = {};

    switch (msg.type) {
      case 'add_item': {
        const current = await this.loadItems(db, listId);
        // afterId 指定時はその直後（fractional indexing）、なければ末尾
        let position: number;
        const afterIdx = msg.afterId ? current.findIndex((i) => i.id === msg.afterId) : -1;
        if (afterIdx >= 0) {
          const after = current[afterIdx]!;
          const next = current[afterIdx + 1];
          position = next ? (after.position + next.position) / 2 : after.position + 1;
        } else {
          position = current.reduce((m, i) => Math.max(m, i.position), 0) + 1;
        }
        const item: Item = { id: nanoid(), text: msg.text, checked: false, color: null, position };
        await db.insert(items).values({
          id: item.id,
          listId,
          text: item.text,
          checked: item.checked,
          color: item.color,
          position: item.position,
          createdAt: now,
          updatedAt: now,
        });
        op = { type: 'add_item', item };
        opDetail = { text: msg.text };
        break;
      }
      case 'update_item': {
        await db
          .update(items)
          .set({ text: msg.text, updatedAt: now })
          .where(and(eq(items.id, msg.itemId), eq(items.listId, listId)));
        op = { type: 'update_item', itemId: msg.itemId, text: msg.text };
        opDetail = { text: msg.text };
        break;
      }
      case 'delete_item': {
        const [target] = await db
          .select({ text: items.text })
          .from(items)
          .where(and(eq(items.id, msg.itemId), eq(items.listId, listId)));
        // ソフトデリート: ゴミ箱へ移動（30日で自動完全削除）
        await db
          .update(items)
          .set({ deletedAt: now, updatedAt: now })
          .where(and(eq(items.id, msg.itemId), eq(items.listId, listId)));
        op = { type: 'delete_item', itemId: msg.itemId };
        opDetail = { text: target?.text };
        break;
      }
      case 'restore_item': {
        await db
          .update(items)
          .set({ deletedAt: null, updatedAt: now })
          .where(and(eq(items.id, msg.itemId), eq(items.listId, listId)));
        const [restored] = await db
          .select({ id: items.id, text: items.text, checked: items.checked, color: items.color, position: items.position })
          .from(items)
          .where(and(eq(items.id, msg.itemId), eq(items.listId, listId)));
        if (!restored) break;
        // クライアントには追加として配れば画面に戻る
        op = { type: 'add_item', item: restored as Item };
        opDetail = { text: restored.text };
        break;
      }
      case 'set_checked': {
        const [target] = await db
          .select({ text: items.text })
          .from(items)
          .where(and(eq(items.id, msg.itemId), eq(items.listId, listId)));
        await db
          .update(items)
          .set({ checked: msg.checked, updatedAt: now })
          .where(and(eq(items.id, msg.itemId), eq(items.listId, listId)));
        op = { type: 'set_checked', itemId: msg.itemId, checked: msg.checked };
        opDetail = { text: target?.text, checked: msg.checked };
        break;
      }
      case 'move_item': {
        await db
          .update(items)
          .set({ position: msg.position, updatedAt: now })
          .where(and(eq(items.id, msg.itemId), eq(items.listId, listId)));
        op = { type: 'move_item', itemId: msg.itemId, position: msg.position };
        break;
      }
      case 'set_color': {
        const [target] = await db
          .select({ text: items.text })
          .from(items)
          .where(and(eq(items.id, msg.itemId), eq(items.listId, listId)));
        await db
          .update(items)
          .set({ color: msg.color, updatedAt: now })
          .where(and(eq(items.id, msg.itemId), eq(items.listId, listId)));
        op = { type: 'set_color', itemId: msg.itemId, color: msg.color };
        opDetail = { text: target?.text, color: msg.color };
        break;
      }
      case 'set_colors': {
        const stmts = msg.changes.map((ch) =>
          db
            .update(items)
            .set({ color: ch.color, updatedAt: now })
            .where(and(eq(items.id, ch.itemId), eq(items.listId, listId))),
        );
        await db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
        op = { type: 'set_colors', changes: msg.changes };
        opDetail = { count: msg.changes.length };
        break;
      }
      case 'set_checked_many': {
        const stmts = msg.itemIds.map((id) =>
          db
            .update(items)
            .set({ checked: msg.checked, updatedAt: now })
            .where(and(eq(items.id, id), eq(items.listId, listId))),
        );
        await db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
        op = { type: 'set_checked_many', itemIds: msg.itemIds, checked: msg.checked };
        opDetail = { count: msg.itemIds.length, checked: msg.checked };
        break;
      }
      case 'reorder': {
        // 渡された順に 1,2,3... を振り直す。渡されなかった項目は末尾に既存順で続ける
        const current = await this.loadItems(db, listId);
        const givenSet = new Set(msg.orderedIds);
        const ordered = [
          ...msg.orderedIds.filter((id) => current.some((i) => i.id === id)),
          ...current.filter((i) => !givenSet.has(i.id)).map((i) => i.id),
        ];
        const stmts = ordered.map((id, idx) =>
          db
            .update(items)
            .set({ position: idx + 1, updatedAt: now })
            .where(and(eq(items.id, id), eq(items.listId, listId))),
        );
        await db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
        const after = await this.loadItems(db, listId);
        op = { type: 'reorder', items: after };
        opDetail = { count: ordered.length };
        break;
      }
    }
    if (!op) return;

    // revision採番 + スナップショット記録 + ブロードキャスト
    const snapshot = await this.loadItems(db, listId);
    const [list] = await db
      .select({ currentRevision: lists.currentRevision })
      .from(lists)
      .where(eq(lists.id, listId));
    const revision = (list?.currentRevision ?? 0) + 1;

    await db.batch([
      db.update(lists).set({ currentRevision: revision, updatedAt: now }).where(eq(lists.id, listId)),
      db.insert(revisions).values({
        listId,
        seq: revision,
        opType: msg.type,
        opDetail: JSON.stringify(opDetail),
        actorType: attachment.actorType,
        actorId: attachment.actorId,
        actorName: attachment.actorName,
        snapshot: JSON.stringify(snapshot),
        createdAt: now,
      }),
    ]);

    // 古い世代の間引きとゴミ箱の期限切れ掃除（たまにでよい）
    if (revision % 20 === 0) {
      if (revision > REVISION_KEEP) {
        await db
          .delete(revisions)
          .where(and(eq(revisions.listId, listId), lte(revisions.seq, revision - REVISION_KEEP)));
      }
      await db
        .delete(items)
        .where(
          and(eq(items.listId, listId), isNotNull(items.deletedAt), lt(items.deletedAt, now - TRASH_KEEP_MS)),
        );
    }

    this.broadcast({
      type: 'op',
      revision,
      op,
      actor: { type: attachment.actorType, name: attachment.actorName },
      clientOpId: 'clientOpId' in msg ? msg.clientOpId : null,
    });
  }

  private async setNickname(ws: WebSocket, attachment: WsAttachment, nickname: string): Promise<void> {
    const listId = await this.getListId();
    await this.db()
      .insert(anonProfiles)
      .values({ listId, anonId: attachment.actorId, nickname, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: [anonProfiles.listId, anonProfiles.anonId],
        set: { nickname, updatedAt: Date.now() },
      });
    ws.serializeAttachment({ ...attachment, actorName: nickname });
  }

  // ---- ヘルパー ----

  private async loadItems(db: DrizzleD1Database, listId: string): Promise<Item[]> {
    const rows = await db
      .select({ id: items.id, text: items.text, checked: items.checked, color: items.color, position: items.position })
      .from(items)
      .where(and(eq(items.listId, listId), isNull(items.deletedAt)))
      .orderBy(asc(items.position));
    return rows as Item[];
  }

  private async sendSync(ws: WebSocket): Promise<void> {
    const db = this.db();
    const listId = await this.getListId();
    const [list] = await db
      .select({ title: lists.title, currentRevision: lists.currentRevision })
      .from(lists)
      .where(eq(lists.id, listId));
    if (!list) {
      this.send(ws, { type: 'error', message: 'list not found' });
      return;
    }
    this.send(ws, {
      type: 'sync',
      revision: list.currentRevision,
      title: list.title,
      items: await this.loadItems(db, listId),
    });
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      ws.send(data);
    }
  }
}
