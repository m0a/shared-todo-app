import { z } from 'zod';

// ---- 共通 ----

// Google Keep風のカラーパレット（名前→表示色）
export const ITEM_COLORS = {
  red: '#f28b82',
  orange: '#fbbc04',
  yellow: '#fff475',
  green: '#ccff90',
  teal: '#a7ffeb',
  blue: '#aecbfa',
  purple: '#d7aefb',
  pink: '#fdcfe8',
  brown: '#e6c9a8',
  gray: '#e8eaed',
} as const;
export type ItemColor = keyof typeof ITEM_COLORS;
export const itemColorSchema = z.enum(
  Object.keys(ITEM_COLORS) as [ItemColor, ...ItemColor[]],
);

export const itemSchema = z.object({
  id: z.string(),
  text: z.string(),
  checked: z.boolean(),
  color: itemColorSchema.nullable(),
  position: z.number(),
});
export type Item = z.infer<typeof itemSchema>;

export const actorSchema = z.object({
  type: z.enum(['owner', 'anon', 'ai']),
  name: z.string().nullable(),
});
export type Actor = z.infer<typeof actorSchema>;

// ---- クライアント → サーバ ----

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('add_item'),
    // Keep風エディタでは空行も作れる（Enterで行分割した直後など）
    text: z.string().max(500),
    // 指定した項目の直後に挿入する。省略時は末尾
    afterId: z.string().optional(),
    clientOpId: z.string(),
  }),
  z.object({
    type: z.literal('update_item'),
    itemId: z.string(),
    text: z.string().max(500),
    clientOpId: z.string(),
  }),
  z.object({
    type: z.literal('delete_item'),
    itemId: z.string(),
    clientOpId: z.string(),
  }),
  z.object({
    type: z.literal('set_checked'),
    itemId: z.string(),
    checked: z.boolean(),
    clientOpId: z.string(),
  }),
  z.object({
    type: z.literal('move_item'),
    itemId: z.string(),
    position: z.number(),
    clientOpId: z.string(),
  }),
  z.object({
    type: z.literal('set_color'),
    itemId: z.string(),
    color: itemColorSchema.nullable(),
    clientOpId: z.string(),
  }),
  // 一括色変更（1世代・1ブロードキャストで処理）
  z.object({
    type: z.literal('set_colors'),
    changes: z
      .array(z.object({ itemId: z.string(), color: itemColorSchema.nullable() }))
      .min(1)
      .max(100),
    clientOpId: z.string(),
  }),
  // 一括並べ替え: 並べたい順の項目ID（1世代・1ブロードキャスト）
  z.object({
    type: z.literal('reorder'),
    orderedIds: z.array(z.string()).min(1).max(200),
    clientOpId: z.string(),
  }),
  z.object({
    type: z.literal('set_nickname'),
    nickname: z.string().min(1).max(50),
  }),
  z.object({ type: z.literal('resync') }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ---- サーバ → クライアント ----

export const serverMessageSchema = z.discriminatedUnion('type', [
  // 接続直後・revision飛び検知時の全量同期
  z.object({
    type: z.literal('sync'),
    revision: z.number(),
    title: z.string(),
    items: z.array(itemSchema),
  }),
  // 操作のブロードキャスト（送信者にもエコー）
  z.object({
    type: z.literal('op'),
    revision: z.number(),
    op: z.discriminatedUnion('type', [
      z.object({ type: z.literal('add_item'), item: itemSchema }),
      z.object({ type: z.literal('update_item'), itemId: z.string(), text: z.string() }),
      z.object({ type: z.literal('delete_item'), itemId: z.string() }),
      z.object({ type: z.literal('set_checked'), itemId: z.string(), checked: z.boolean() }),
      z.object({ type: z.literal('move_item'), itemId: z.string(), position: z.number() }),
      z.object({ type: z.literal('set_color'), itemId: z.string(), color: itemColorSchema.nullable() }),
      z.object({
        type: z.literal('set_colors'),
        changes: z.array(z.object({ itemId: z.string(), color: itemColorSchema.nullable() })),
      }),
      z.object({ type: z.literal('reorder'), items: z.array(itemSchema) }),
    ]),
    actor: actorSchema,
    clientOpId: z.string().nullable(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
