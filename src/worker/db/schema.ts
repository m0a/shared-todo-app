import { sqliteTable, text, integer, real, primaryKey, index } from 'drizzle-orm/sqlite-core';

// 作成者アカウント
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  createdAt: integer('created_at').notNull(),
});

// パスキー資格情報（1ユーザー複数可）
export const credentials = sqliteTable('credentials', {
  id: text('id').primaryKey(), // credential ID (base64url)
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  // WorkersにはNodeのBufferが無いため、公開鍵はbase64url文字列で保存する
  publicKey: text('public_key').notNull(),
  counter: integer('counter').notNull().default(0),
  transports: text('transports'), // JSON配列
  createdAt: integer('created_at').notNull(),
});

// MCP用 Bearer トークン（ハッシュのみ保存）
export const apiTokens = sqliteTable('api_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(), // SHA-256(token)
  label: text('label'),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
});

// リスト
export const lists = sqliteTable(
  'lists',
  {
    id: text('id').primaryKey(),
    shareToken: text('share_token').notNull().unique(), // URL用ランダムトークン
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    currentRevision: integer('current_revision').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_lists_owner').on(t.ownerId)],
);

// 項目（現在状態）
export const items = sqliteTable(
  'items',
  {
    id: text('id').primaryKey(),
    listId: text('list_id')
      .notNull()
      .references(() => lists.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    checked: integer('checked', { mode: 'boolean' }).notNull().default(false),
    position: real('position').notNull(), // fractional indexing
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_items_list').on(t.listId)],
);

// 世代管理（スナップショット方式）
export const revisions = sqliteTable(
  'revisions',
  {
    listId: text('list_id')
      .notNull()
      .references(() => lists.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(), // リスト内連番（DOが採番）
    opType: text('op_type').notNull(), // add|update|delete|check|uncheck|move|restore|rename
    opDetail: text('op_detail'), // JSON: 履歴表示用の要約
    actorType: text('actor_type').notNull(), // owner|anon|ai
    actorId: text('actor_id').notNull(),
    actorName: text('actor_name'),
    snapshot: text('snapshot').notNull(), // JSON: その時点の items 全量
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.listId, t.seq] })],
);

// 匿名ユーザーのニックネーム（端末ID→表示名）
export const anonProfiles = sqliteTable(
  'anon_profiles',
  {
    listId: text('list_id')
      .notNull()
      .references(() => lists.id, { onDelete: 'cascade' }),
    anonId: text('anon_id').notNull(), // クライアント生成UUID
    nickname: text('nickname').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.listId, t.anonId] })],
);
