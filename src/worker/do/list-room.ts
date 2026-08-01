import { DurableObject } from 'cloudflare:workers';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { eq, and, lte, asc } from 'drizzle-orm';
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

    // MCP・REST（restore等）からのミューテーション用HTTPエントリ（フェーズ4/5で拡張）
    return new Response('Not found', { status: 404 });
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
        const maxPos = current.reduce((m, i) => Math.max(m, i.position), 0);
        const item: Item = { id: nanoid(), text: msg.text, checked: false, position: maxPos + 1 };
        await db.insert(items).values({
          id: item.id,
          listId,
          text: item.text,
          checked: item.checked,
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
        await db.delete(items).where(and(eq(items.id, msg.itemId), eq(items.listId, listId)));
        op = { type: 'delete_item', itemId: msg.itemId };
        opDetail = { text: target?.text };
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

    // 古い世代の間引き（たまにでよい）
    if (revision % 20 === 0 && revision > REVISION_KEEP) {
      await db
        .delete(revisions)
        .where(and(eq(revisions.listId, listId), lte(revisions.seq, revision - REVISION_KEEP)));
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
      .select({ id: items.id, text: items.text, checked: items.checked, position: items.position })
      .from(items)
      .where(eq(items.listId, listId))
      .orderBy(asc(items.position));
    return rows;
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
