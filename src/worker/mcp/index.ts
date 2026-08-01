import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPTransport } from '@hono/mcp';
import type { Context } from 'hono';
import { z } from 'zod';
import { drizzle } from 'drizzle-orm/d1';
import { eq, asc, desc } from 'drizzle-orm';
import { lists, items, apiTokens } from '../db/schema';
import { itemColorSchema, type ClientMessage } from '../../shared/ws-protocol';

export async function sha256hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Bearer トークンを検証し、ユーザーIDとトークンIDを返す */
export async function verifyApiToken(
  env: Env,
  authorization: string | undefined,
): Promise<{ userId: string; tokenId: string } | null> {
  const token = authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return null;
  const db = drizzle(env.DB);
  const [row] = await db
    .select({ id: apiTokens.id, userId: apiTokens.userId })
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, await sha256hex(token)));
  if (!row) return null;
  await db.update(apiTokens).set({ lastUsedAt: Date.now() }).where(eq(apiTokens.id, row.id));
  return { userId: row.userId, tokenId: row.id };
}

/** MCPリクエスト1件を処理する（stateless: リクエストごとにサーバを組み立てる） */
export async function handleMcpRequest(
  c: Context<{ Bindings: Env }>,
  auth: { userId: string; tokenId: string },
): Promise<Response> {
  const env = c.env;
  const db = drizzle(env.DB);

  // このトークンの所有者のリストであることを確認して返す
  async function ownedList(listId: string) {
    const [list] = await db
      .select({ id: lists.id, title: lists.title, ownerId: lists.ownerId })
      .from(lists)
      .where(eq(lists.id, listId));
    if (!list || list.ownerId !== auth.userId) throw new Error(`list not found: ${listId}`);
    return list;
  }

  // ミューテーションはWS操作と同じ経路（ListRoom DO）に乗せ、接続中の全員へ即時配信する
  async function mutate(listId: string, op: ClientMessage): Promise<void> {
    const stub = env.LIST_ROOM.get(env.LIST_ROOM.idFromName(listId));
    const res = await stub.fetch('https://do/mutate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-List-Id': listId },
      body: JSON.stringify({
        op,
        actor: { actorType: 'ai', actorId: auth.tokenId, actorName: 'AI' },
      }),
    });
    if (!res.ok) throw new Error(`mutation failed: ${res.status}`);
  }

  function textResult(data: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] };
  }

  const origin = new URL(c.req.url).origin;
  const shareUrl = (shareToken: string) => `${origin}/l/${shareToken}`;

  const server = new McpServer({ name: 'shared-todo', version: '0.1.0' });

  server.registerTool(
    'list_todo_lists',
    { description: '自分のTodoリスト一覧を取得する（共有URL付き）', inputSchema: {} },
    async () => {
      const rows = await db
        .select({ id: lists.id, title: lists.title, shareToken: lists.shareToken, updatedAt: lists.updatedAt })
        .from(lists)
        .where(eq(lists.ownerId, auth.userId))
        .orderBy(desc(lists.updatedAt));
      return textResult(rows.map(({ shareToken, ...r }) => ({ ...r, shareUrl: shareUrl(shareToken) })));
    },
  );

  server.registerTool(
    'get_share_link',
    {
      description:
        'リストの共有リンクを取得する。このURLを知っている人は誰でも（ログインなしで）リストを閲覧・編集できる。LINE等で共有する用途',
      inputSchema: { list_id: z.string() },
    },
    async ({ list_id }) => {
      const db2 = drizzle(env.DB);
      const [list] = await db2
        .select({ title: lists.title, shareToken: lists.shareToken, ownerId: lists.ownerId })
        .from(lists)
        .where(eq(lists.id, list_id));
      if (!list || list.ownerId !== auth.userId) throw new Error(`list not found: ${list_id}`);
      return textResult({ title: list.title, shareUrl: shareUrl(list.shareToken) });
    },
  );

  server.registerTool(
    'get_items',
    {
      description: 'リストの項目一覧（チェック状態含む）を取得する',
      inputSchema: { list_id: z.string().describe('リストID（list_todo_listsで取得）') },
    },
    async ({ list_id }) => {
      const list = await ownedList(list_id);
      const rows = await db
        .select({ id: items.id, text: items.text, checked: items.checked, color: items.color })
        .from(items)
        .where(eq(items.listId, list.id))
        .orderBy(asc(items.position));
      return textResult({ title: list.title, items: rows });
    },
  );

  server.registerTool(
    'add_items',
    {
      description: 'リストに項目を追加する（複数一括可）',
      inputSchema: {
        list_id: z.string(),
        texts: z.array(z.string().min(1).max(500)).min(1).max(50).describe('追加する項目のテキスト配列'),
      },
    },
    async ({ list_id, texts }) => {
      await ownedList(list_id);
      for (const text of texts) {
        await mutate(list_id, { type: 'add_item', text, clientOpId: crypto.randomUUID() });
      }
      return textResult({ added: texts.length });
    },
  );

  server.registerTool(
    'update_item',
    {
      description: '項目のテキストを変更する',
      inputSchema: { list_id: z.string(), item_id: z.string(), text: z.string().min(1).max(500) },
    },
    async ({ list_id, item_id, text }) => {
      await ownedList(list_id);
      await mutate(list_id, { type: 'update_item', itemId: item_id, text, clientOpId: crypto.randomUUID() });
      return textResult({ ok: true });
    },
  );

  server.registerTool(
    'delete_item',
    { description: '項目を削除する', inputSchema: { list_id: z.string(), item_id: z.string() } },
    async ({ list_id, item_id }) => {
      await ownedList(list_id);
      await mutate(list_id, { type: 'delete_item', itemId: item_id, clientOpId: crypto.randomUUID() });
      return textResult({ ok: true });
    },
  );

  server.registerTool(
    'check_item',
    { description: '項目にチェックを付ける', inputSchema: { list_id: z.string(), item_id: z.string() } },
    async ({ list_id, item_id }) => {
      await ownedList(list_id);
      await mutate(list_id, { type: 'set_checked', itemId: item_id, checked: true, clientOpId: crypto.randomUUID() });
      return textResult({ ok: true });
    },
  );

  server.registerTool(
    'set_item_color',
    {
      description:
        '項目に色を付ける（食材の種類ごとの色分け等に）。色: red/orange/yellow/green/teal/blue/purple/pink/brown/gray、nullで色を外す',
      inputSchema: {
        list_id: z.string(),
        item_id: z.string(),
        color: itemColorSchema.nullable(),
      },
    },
    async ({ list_id, item_id, color }) => {
      await ownedList(list_id);
      await mutate(list_id, { type: 'set_color', itemId: item_id, color, clientOpId: crypto.randomUUID() });
      return textResult({ ok: true });
    },
  );

  server.registerTool(
    'move_item',
    {
      description: '項目を並べ替える。after_item_id の直後に移動する（省略時は先頭へ）',
      inputSchema: {
        list_id: z.string(),
        item_id: z.string(),
        after_item_id: z.string().optional().describe('この項目の直後に移動する。省略すると先頭'),
      },
    },
    async ({ list_id, item_id, after_item_id }) => {
      await ownedList(list_id);
      const rows = await db
        .select({ id: items.id, position: items.position })
        .from(items)
        .where(eq(items.listId, list_id))
        .orderBy(asc(items.position));
      let position: number;
      if (after_item_id) {
        const idx = rows.findIndex((r) => r.id === after_item_id);
        if (idx < 0) throw new Error(`item not found: ${after_item_id}`);
        const next = rows[idx + 1];
        position = next ? (rows[idx]!.position + next.position) / 2 : rows[idx]!.position + 1;
      } else {
        position = (rows[0]?.position ?? 1) - 1;
      }
      await mutate(list_id, { type: 'move_item', itemId: item_id, position, clientOpId: crypto.randomUUID() });
      return textResult({ ok: true });
    },
  );

  server.registerTool(
    'uncheck_item',
    { description: '項目のチェックを外す', inputSchema: { list_id: z.string(), item_id: z.string() } },
    async ({ list_id, item_id }) => {
      await ownedList(list_id);
      await mutate(list_id, { type: 'set_checked', itemId: item_id, checked: false, clientOpId: crypto.randomUUID() });
      return textResult({ ok: true });
    },
  );

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return (await transport.handleRequest(c)) ?? new Response(null, { status: 204 });
}
