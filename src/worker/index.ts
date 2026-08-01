import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { lists } from './db/schema';
import { createAuthApp, getSessionUserId } from './auth/index';

export { ListRoom } from './do/list-room';

const app = new Hono<{ Bindings: Env }>()
  .get('/api/health', (c) => c.json({ ok: true }))

  // フロントエンドのエラー転送先（スマホからdevtoolsが見られないため、サーバログで監視する）
  .post(
    '/api/client-log',
    zValidator(
      'json',
      z.object({
        level: z.enum(['error', 'warn']),
        message: z.string().max(2000),
        stack: z.string().max(4000).optional(),
        url: z.string().max(500),
        ua: z.string().max(300).optional(),
      }),
    ),
    (c) => {
      const log = c.req.valid('json');
      console.error(`[client-${log.level}] ${log.message}`, {
        url: log.url,
        stack: log.stack,
        ua: log.ua,
      });
      return c.json({ ok: true });
    },
  )

  // ---- パスキー認証 ----
  .route('/api/auth', createAuthApp())

  // ---- リスト管理（作成者のみ・要ログイン） ----
  .post(
    '/api/lists',
    zValidator('json', z.object({ title: z.string().min(1).max(100) })),
    async (c) => {
      const userId = await getSessionUserId(c, c.env.SESSION_SECRET);
      if (!userId) return c.json({ error: 'unauthorized' }, 401);
      const db = drizzle(c.env.DB);
      const now = Date.now();
      const list = {
        id: nanoid(),
        shareToken: nanoid(22),
        ownerId: userId,
        title: c.req.valid('json').title,
        currentRevision: 0,
        createdAt: now,
        updatedAt: now,
      };
      await db.insert(lists).values(list);
      return c.json({ id: list.id, shareToken: list.shareToken, title: list.title }, 201);
    },
  )
  .get('/api/lists', async (c) => {
    const userId = await getSessionUserId(c, c.env.SESSION_SECRET);
    if (!userId) return c.json({ error: 'unauthorized' }, 401);
    const db = drizzle(c.env.DB);
    const rows = await db
      .select({ id: lists.id, shareToken: lists.shareToken, title: lists.title, updatedAt: lists.updatedAt })
      .from(lists)
      .where(eq(lists.ownerId, userId))
      .orderBy(desc(lists.updatedAt));
    return c.json({ lists: rows });
  })
  .delete('/api/lists/:id', async (c) => {
    const userId = await getSessionUserId(c, c.env.SESSION_SECRET);
    if (!userId) return c.json({ error: 'unauthorized' }, 401);
    const db = drizzle(c.env.DB);
    const [deleted] = await db
      .delete(lists)
      .where(and(eq(lists.id, c.req.param('id')), eq(lists.ownerId, userId)))
      .returning({ id: lists.id });
    if (!deleted) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  })

  // リストメタ取得（共有URL経由・認証不要）
  .get('/api/l/:shareToken', async (c) => {
    const db = drizzle(c.env.DB);
    const [list] = await db
      .select({ id: lists.id, title: lists.title })
      .from(lists)
      .where(eq(lists.shareToken, c.req.param('shareToken')));
    if (!list) return c.json({ error: 'not found' }, 404);
    return c.json({ title: list.title });
  })

  // WebSocket → ListRoom DO へルーティング（共有URL経由・認証不要）
  .get('/api/l/:shareToken/ws', async (c) => {
    if (c.req.header('Upgrade') !== 'websocket') {
      return c.json({ error: 'expected websocket' }, 426);
    }
    const db = drizzle(c.env.DB);
    const [list] = await db
      .select({ id: lists.id, ownerId: lists.ownerId })
      .from(lists)
      .where(eq(lists.shareToken, c.req.param('shareToken')));
    if (!list) return c.json({ error: 'not found' }, 404);

    // ログイン済みの作成者なら owner として、それ以外は匿名として接続する
    const userId = await getSessionUserId(c, c.env.SESSION_SECRET);
    const isOwner = userId !== null && userId === list.ownerId;
    const anonId = c.req.query('anonId') ?? 'unknown';

    const headers = new Headers(c.req.raw.headers);
    headers.set('X-List-Id', list.id);
    headers.set('X-Actor-Type', isOwner ? 'owner' : 'anon');
    headers.set('X-Actor-Id', isOwner ? userId : anonId);

    const stub = c.env.LIST_ROOM.get(c.env.LIST_ROOM.idFromName(list.id));
    return stub.fetch(new Request(c.req.raw.url, { headers }));
  });

// Hono RPC 用の型。クライアントは hc<AppType>('/') で型付きアクセスする
export type AppType = typeof app;

export default app;
