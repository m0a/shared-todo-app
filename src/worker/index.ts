import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { users, lists } from './db/schema';

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

  // ---- 暫定: パスキー認証はフェーズ3で実装。それまでの間、認証なしでリスト作成できる開発用API ----
  .post(
    '/api/dev/lists',
    zValidator('json', z.object({ title: z.string().min(1).max(100) })),
    async (c) => {
      const db = drizzle(c.env.DB);
      const now = Date.now();
      // 暫定の開発用オーナー（フェーズ3で本物のユーザーに置き換える）
      const DEV_USER_ID = 'dev-user';
      await db
        .insert(users)
        .values({ id: DEV_USER_ID, displayName: 'Dev User', createdAt: now })
        .onConflictDoNothing();

      const list = {
        id: nanoid(),
        shareToken: nanoid(22),
        ownerId: DEV_USER_ID,
        title: c.req.valid('json').title,
        currentRevision: 0,
        createdAt: now,
        updatedAt: now,
      };
      await db.insert(lists).values(list);
      return c.json({ shareToken: list.shareToken, title: list.title }, 201);
    },
  )

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
      .select({ id: lists.id })
      .from(lists)
      .where(eq(lists.shareToken, c.req.param('shareToken')));
    if (!list) return c.json({ error: 'not found' }, 404);

    // 匿名ユーザーの端末ID（クライアント生成、localStorage保持）をDOへ引き渡す
    const anonId = c.req.query('anonId') ?? 'unknown';
    const headers = new Headers(c.req.raw.headers);
    headers.set('X-List-Id', list.id);
    headers.set('X-Actor-Type', 'anon');
    headers.set('X-Actor-Id', anonId);

    const stub = c.env.LIST_ROOM.get(c.env.LIST_ROOM.idFromName(list.id));
    return stub.fetch(new Request(c.req.raw.url, { headers }));
  });

// Hono RPC 用の型。クライアントは hc<AppType>('/') で型付きアクセスする
export type AppType = typeof app;

export default app;
