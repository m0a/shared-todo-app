# 共有Todoリストアプリ 設計書

作成日: 2026-08-01。要件は [requirements.md](./requirements.md) を参照。

## 全体アーキテクチャ

```
┌─ ブラウザ (React/Vite) ──┐        ┌─ AIクライアント (Claude Code等) ─┐
│  WebSocket + REST        │        │  MCP (http transport + Bearer)   │
└────────────┬─────────────┘        └────────────────┬─────────────────┘
             │                                       │
        Cloudflare Worker (Hono)
             │  認証(パスキー) / REST / MCP エンドポイント
             ▼
        Durable Object「ListRoom」(1リスト = 1インスタンス)
             │  全ミューテーションを直列化・revision採番・WSブロードキャスト
             ▼
        D1 (永続化: users / lists / items / revisions ...)
```

**設計の要**: リストへの変更（ブラウザからもMCPからも）は**必ずそのリストの ListRoom DO を経由**する。DOがシングルスレッドで書き込みを直列化するので、revision 採番の競合が原理的に起きない。DOはD1へ書き込んだ後、接続中の全WebSocketへブロードキャストする。

## D1 スキーマ

```sql
-- 作成者アカウント
CREATE TABLE users (
  id TEXT PRIMARY KEY,              -- UUID
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL       -- unix ms
);

-- パスキー資格情報（1ユーザー複数可）
CREATE TABLE credentials (
  id TEXT PRIMARY KEY,              -- credential ID (base64url)
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,                  -- JSON配列
  created_at INTEGER NOT NULL
);

-- MCP用 Bearer トークン（ハッシュのみ保存）
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,  -- SHA-256(token)
  label TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

-- リスト
CREATE TABLE lists (
  id TEXT PRIMARY KEY,              -- UUID
  share_token TEXT NOT NULL UNIQUE, -- URL用 128bitランダム(base64url 22文字)
  owner_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  current_revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_lists_owner ON lists(owner_id);

-- 項目（現在状態）
CREATE TABLE items (
  id TEXT PRIMARY KEY,              -- UUID
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0,
  position REAL NOT NULL,           -- fractional indexing（並び替え時に他行を触らない）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_items_list ON items(list_id);

-- 世代管理（スナップショット方式）
CREATE TABLE revisions (
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,             -- リスト内連番（DOが採番）
  op_type TEXT NOT NULL,            -- add|update|delete|check|uncheck|restore|rename
  op_detail TEXT,                   -- JSON: 対象項目・変更内容の要約（履歴表示用）
  actor_type TEXT NOT NULL,         -- owner|anon|ai
  actor_id TEXT NOT NULL,           -- owner: user_id / anon: 端末ID / ai: token_id
  actor_name TEXT,                  -- 表示名スナップショット（ニックネーム等）
  snapshot TEXT NOT NULL,           -- JSON: その時点の items 全量
  created_at INTEGER NOT NULL,
  PRIMARY KEY (list_id, seq)
);

-- 匿名ユーザーのニックネーム（端末ID→表示名）
CREATE TABLE anon_profiles (
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  anon_id TEXT NOT NULL,            -- クライアント生成UUID（localStorage保持）
  nickname TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (list_id, anon_id)
);
```

### 世代管理はスナップショット方式

diff方式ではなく**毎revisionで items 全量のJSONスナップショット**を保存する。

- 理由: 買い物リストは高々数十項目 → 1スナップショット数KB。restore（Undo）が「スナップショットを読んで items を全置換」だけで済み、diff再生の複雑さ・バグリスクがない
- 履歴一覧の表示には `op_type` + `op_detail`（「『牛乳』を追加」等の要約）を使い、snapshot は restore 時だけ読む
- 肥大化対策: 1リストあたり直近 **500 revision** を保持し、それより古いものはDOがミューテーション時に間引く

## Durable Object「ListRoom」

- 命名: `idFromName(list_id)`。Worker は share_token → list_id を D1 で解決してから DO へルーティング
- **WebSocket Hibernation API** を使用（`state.acceptWebSocket()` + `webSocketMessage()`）。接続保持中の課金を回避
- 各WS接続の attachment に `{actorType, actorId, actorName}` を保持
- ミューテーション処理（WS経由・HTTP経由共通）:
  1. 入力検証
  2. D1 に items 変更 + revisions 挿入 + lists.current_revision 更新（`batch` で原子的に）
  3. 全接続へブロードキャスト

### WebSocket プロトコル（packages/shared で型定義）

クライアント → サーバ:

```jsonc
{ "type": "add_item",    "text": "牛乳", "clientOpId": "..." }
{ "type": "update_item", "itemId": "...", "text": "低脂肪牛乳" }
{ "type": "delete_item", "itemId": "..." }
{ "type": "set_checked", "itemId": "...", "checked": true }
{ "type": "move_item",   "itemId": "...", "position": 3.5 }
{ "type": "set_nickname","nickname": "まこと" }
```

サーバ → クライアント:

```jsonc
// 接続直後に全量同期
{ "type": "sync", "revision": 42, "title": "...", "items": [ ... ] }
// 以後は操作ごとに revision 付きでブロードキャスト（送信者にもエコー）
{ "type": "op", "revision": 43, "op": { /* 上記クライアント操作 + itemId等の確定値 */ },
  "actor": { "type": "anon", "name": "まこと" }, "clientOpId": "..." }
// 作成者がUndoしたとき・revision飛びを検知したときは sync を再送
```

- クライアントは受信 revision が「手元+1」でなければ `{"type":"resync"}` を送って全量同期し直す（≤10人・小さいリストなので全量再送のコストは無視できる）
- 楽観的UI更新: 送信時に即ローカル反映し、`clientOpId` のエコーで確定。オフライン編集キューはスコープ外（要件どおりリアルタイム前提）
- WSメッセージは Hono RPC の対象外なので、この節のプロトコルを `packages/shared` に zod スキーマとして定義し、フロント・DO 双方で parse する（型と実行時検証を一元化）

## 認証まわり

### パスキー（作成者のみ）

- `@simplewebauthn/server`（Worker側）+ `@simplewebauthn/browser`（フロント側）
- 登録: `POST /api/auth/register/options` → `POST /api/auth/register/verify`（ユーザー名入力→パスキー作成）
- ログイン: `POST /api/auth/login/options` → `POST /api/auth/login/verify`（discoverable credential で ユーザー名入力なしのワンタップ）
- セッション: 署名付き HttpOnly Cookie（有効期限 30日）。チャレンジは DO か KV に短期保存
- E2E テストは cdp-e2e スキル（仮想パスキー）で行う

### 匿名ユーザー

- 認証なし。`share_token` を知っていること自体が認可
- 端末IDは初回アクセス時にクライアントが UUID 生成し localStorage に保持。WS接続時に送る

### MCP

- `/api/mcp`(http transport)。`Authorization: Bearer <token>` を SHA-256 して api_tokens と照合
- トークン発行は設定画面から（作成者ログイン後）。発行時に一度だけ平文表示

## REST API（WS以外で必要なもの）

**Hono RPC を採用**: バックエンドのルート定義（zod-validator付き）から `AppType` を export し、フロントは `hc<AppType>` の型付きクライアントで呼ぶ。リクエスト/レスポンスの型はルート定義から自動導出されるので、API用の型を `packages/shared` に手書きしない。**Hono RPC がカバーするのはHTTPのみ**で、WSプロトコルとMCPは対象外（それぞれ後述の方式）。

| Method | Path | 認証 | 用途 |
|---|---|---|---|
| POST | /api/lists | owner | リスト作成（share_token発行） |
| GET | /api/lists | owner | 自分のリスト一覧 |
| DELETE | /api/lists/:id | owner | リスト削除 |
| GET | /api/l/:shareToken | 不要 | リストメタ取得（タイトル・WS接続先） |
| GET | /api/l/:shareToken/ws | 不要 | WebSocket アップグレード → DO |
| GET | /api/lists/:id/revisions | owner | 履歴一覧（op要約のみ） |
| POST | /api/lists/:id/restore | owner | 指定 seq へ復元（DO経由） |
| POST | /api/tokens | owner | MCPトークン発行 |

## MCPツール

要件どおり: `list_todo_lists` / `get_items` / `add_items`（一括） / `update_item` / `delete_item` / `check_item` / `uncheck_item`。
実装は Hono ルート内で該当リストの DO に fetch し、通常のミューテーションと同一経路に乗せる（actor_type='ai'）。

## プロジェクト構成（単一Viteプロジェクト + @cloudflare/vite-plugin）

Cloudflare 公式推奨の最新構成。`vite dev` 一発でフロントと Worker が同時に起動（Worker は workerd 上で実行、HMR対応）。`vite build && wrangler deploy` で静的アセットごと単一デプロイ。pnpm workspaces のモノレポにはしない — 同一TSプロジェクト内なので Hono RPC の型が直接流れ、共有パッケージのビルドも不要。

```
shared-todo-app/
├── docs/                     # requirements.md / design.md
├── index.html                # Vite エントリ
├── vite.config.ts            # react() + cloudflare()
├── wrangler.jsonc            # D1 + DO バインディング（最新のjsonc形式）
├── drizzle.config.ts
├── migrations/               # drizzle-kit generate → wrangler d1 migrations apply
└── src/
    ├── worker/
    │   ├── index.ts          # Honoアプリ（AppType を export）+ ListRoom re-export
    │   ├── do/list-room.ts   # Durable Object
    │   ├── auth/             # パスキー・セッション・トークン（フェーズ3）
    │   ├── mcp/              # MCPエンドポイント（フェーズ5）
    │   └── db/schema.ts      # Drizzle スキーマ
    ├── shared/ws-protocol.ts # WSプロトコルの zod スキーマ（フロント・DO双方でparse）
    └── client/               # React（モバイルファースト）。hc<AppType> でAPI呼び出し
```

- 主要バージョン: wrangler 4 / Hono 4.12 / zod 4 / Vite 8 / React 19 / Drizzle 0.45（2026-08 時点の最新）
- 型: `wrangler types` が `worker-configuration.d.ts` に `Env` を自動生成（`@cloudflare/workers-types` は使わない最新方式）
- DO は `new_sqlite_classes`（SQLiteバックエンド）で登録

## 実装フェーズ分割

1. **スキャフォールド**: Vite + cloudflare plugin + wrangler.jsonc + D1マイグレーション + 空のDO ✅（2026-08-01完了）
2. **コア**: ListRoom DO + WS同期 + Keep風UI（匿名アクセスのみ、認証なしで動くところまで）
3. **認証**: パスキー登録/ログイン + リスト作成/削除/一覧
4. **履歴**: revisions 記録 + 履歴画面 + restore（Undo）
5. **MCP**: エンドポイント + トークン発行UI + `~/.claude.json` 登録
6. **仕上げ**: デプロイ（workers.dev）、cdp-e2e でパスキーE2E
