import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { lists } from './db/schema';

export { ListRoom } from './do/list-room';

const app = new Hono<{ Bindings: Env }>()
  .get('/api/health', (c) => c.json({ ok: true }))

  // リストメタ取得（共有URL経由・認証不要）
  .get('/api/l/:shareToken', async (c) => {
    const db = drizzle(c.env.DB);
    const [list] = await db
      .select({ id: lists.id, title: lists.title })
      .from(lists)
      .where(eq(lists.shareToken, c.req.param('shareToken')));
    if (!list) return c.json({ error: 'not found' }, 404);
    return c.json(list);
  })

  // WebSocket → ListRoom DO へルーティング（共有URL経由・認証不要）
  .get('/api/l/:shareToken/ws', async (c) => {
    if (c.req.header('Upgrade') !== 'websocket') {
      return c.json({ error: 'expected websocket' }, 426);
    }
    const db = drizzle(c.env.DB);
    const [list] = await db
      .select({ id: lists.id })
      .from(lists)
      .where(eq(lists.shareToken, c.req.param('shareToken')));
    if (!list) return c.json({ error: 'not found' }, 404);

    const stub = c.env.LIST_ROOM.get(c.env.LIST_ROOM.idFromName(list.id));
    return stub.fetch(c.req.raw);
  });

// Hono RPC 用の型。クライアントは hc<AppType>('/') で型付きアクセスする
export type AppType = typeof app;

export default app;
