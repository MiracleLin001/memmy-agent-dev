import { z } from "zod";

/** Raw, read-only Computer Use history is separate from human activity summaries. */
export const CuHistoryKindSchema = z.enum(["prompt", "reasoning", "tool_call", "ui_text", "screenshot"]);
export type CuHistoryKind = z.infer<typeof CuHistoryKindSchema>;

export const CuHistoryEventSchema = z.object({
  id: z.string(),
  kind: CuHistoryKindSchema,
  timestamp: z.string(),
  orderKey: z.string(),
  title: z.string(),
  summary: z.string(),
  source: z.enum(["recorder", "session", "transcript"]),
  sessionId: z.string().nullable(),
  completeness: z.enum(["complete", "partial"]),
  missingReason: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  parentId: z.string().nullable(),
}).strict();
export type CuHistoryEvent = z.infer<typeof CuHistoryEventSchema>;

export const CuHistoryPageSchema = z.object({
  events: z.array(CuHistoryEventSchema),
  nextCursor: z.string().nullable(),
}).strict();
export type CuHistoryPage = z.infer<typeof CuHistoryPageSchema>;

export const CuHistoryEventDetailSchema = CuHistoryEventSchema.extend({
  text: z.string().nullable(),
  args: z.record(z.string(), z.unknown()).nullable(),
  result: z.unknown(),
  screenshot: z.object({
    assetId: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number().int().nonnegative(),
  }).strict().nullable(),
}).strict();
export type CuHistoryEventDetail = z.infer<typeof CuHistoryEventDetailSchema>;

export const CuHistoryAssetSchema = z.object({
  mimeType: z.string(),
  dataBase64: z.string(),
}).strict();
export type CuHistoryAsset = z.infer<typeof CuHistoryAssetSchema>;

export interface CuHistoryListOptions {
  limit?: number;
  cursor?: string | null;
  from?: string;
  to?: string;
  kind?: CuHistoryKind;
  sessionId?: string;
  turnId?: string;
  signal?: AbortSignal;
}
