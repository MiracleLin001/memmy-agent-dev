import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "../../config/paths.js";
import { detectImageMime } from "../../utils/helpers.js";

/**
 * Agent Computer Use evidence is deliberately separate from the human
 * Computer History recorder. The latter never records screenshots by default.
 */
export type ComputerUseHistoryKind = "prompt" | "tool_call" | "ui_text" | "screenshot";
export type ComputerUseHistorySource = "recorder" | "session" | "transcript";
export type ComputerUseHistoryCompleteness = "complete" | "partial";
export type ComputerUseCallStatus =
  | "pending" | "ok" | "error" | "blocked" | "uncertain" | "timeout" | "cancelled";

export interface ComputerUseScreenshot {
  assetId: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ComputerUseHistorySummary {
  id: string;
  kind: ComputerUseHistoryKind;
  timestamp: string;
  /** Lexically sortable capture order, monotonic across recorder restarts. */
  orderKey: string;
  title: string;
  summary: string;
  source: ComputerUseHistorySource;
  sessionId: string | null;
  completeness: ComputerUseHistoryCompleteness;
  missingReason: string | null;
  metadata: Record<string, unknown>;
  parentId: string | null;
}

export interface ComputerUseHistoryEvent extends ComputerUseHistorySummary {
  text: string | null;
  args: Record<string, unknown> | null;
  result: unknown | null;
  screenshot: ComputerUseScreenshot | null;
}

export interface ComputerUseRecordContext {
  sessionId?: string | null;
  turnId?: string | null;
  messageId?: string | null;
  channel?: string | null;
  chatId?: string | null;
  promptText?: string | null;
  /** Original inbound message time when available; capture order uses orderKey. */
  promptTimestamp?: string | null;
}

export interface ComputerUseCallHandle {
  id: string;
  startedAtMs: number;
}

export interface ComputerUseCallOutcome {
  status?: ComputerUseCallStatus;
  attemptCount?: number;
  dispatched?: boolean | null;
  error?: string | null;
}

export class ComputerUseHistoryError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};
const IMAGE_LIMIT_BYTES = 20 * 1024 * 1024;
const EVENT_LIMIT_BYTES = 64 * 1024 * 1024;
const RECORD_ID = /^\d{4}-\d{2}-\d{2}-(?:[a-f0-9-]{36}|p-[a-f0-9]{40})$/;
const ASSET_ID = /^[a-f0-9]{64}$/;
const ORDER_KEY = /^\d{13}-\d{12}-[a-f0-9]{8}$/;

export function isComputerUseHistorySupported(platform = process.platform): boolean {
  return platform === "darwin" || platform === "win32";
}

function compactPreview(text: string, limit = 180): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
}

function digest(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function timestampFromId(id: string): string | null {
  if (!RECORD_ID.test(id)) return null;
  const day = id.slice(0, 10);
  return Number.isNaN(Date.parse(`${day}T00:00:00.000Z`)) ? null : day;
}

function recordObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

const DATA_IMAGE_URI = /data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;

function binaryPayloadPlaceholder(length: number): string {
  return `[binary payload omitted: ${length} characters]`;
}

function likelyBinaryBase64(value: string, key: string): boolean {
  if (!/^[A-Za-z0-9+/=\s]+$/.test(value)) return false;
  const canonical = value.replace(/\s+/g, "");
  if (canonical.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(canonical)) return false;
  const sample = Buffer.from(canonical.slice(0, 4096), "base64");
  if (!sample.length) return false;
  if (detectImageMime(sample)) return true;
  return value.length > 512
    && !/[ \t]/.test(value)
    && /(?:base64|image[_-]?data|screenshot[_-]?data|^data$|^image$|^screenshot$)/i.test(key);
}

export function redactComputerUseImagePayloads(value: string, key = ""): string {
  const withoutDataUris = value.replace(DATA_IMAGE_URI, (uri) => binaryPayloadPlaceholder(uri.length));
  return likelyBinaryBase64(withoutDataUris, key)
    ? binaryPayloadPlaceholder(value.length)
    : withoutDataUris;
}

function jsonSafe(value: unknown, key = "", seen = new WeakSet<object>(), depth = 0): unknown {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value ?? null;
  if (typeof value === "bigint") return value.toString();
  // The image content blocks are handled separately. A server can also put
  // the same binary in structuredContent or even a text block; do not inline
  // it into the event JSON while preserving ordinary long UI text.
  if (typeof value === "string") return redactComputerUseImagePayloads(value, key);
  if (typeof value !== "object") return String(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[binary payload omitted: ${value.byteLength} bytes]`;
  if (seen.has(value)) return "[circular value]";
  if (depth > 32) return "[nested value omitted]";
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map((item) => jsonSafe(item, "", seen, depth + 1))
    : Object.fromEntries(Object.entries(value).map(([field, item]) => [field, jsonSafe(item, field, seen, depth + 1)]));
  seen.delete(value);
  return result;
}

function validatedImage(data: string, declaredMime: string): { bytes: Buffer; mimeType: string } {
  const canonical = data.replace(/\s+/g, "");
  if (!canonical || canonical.length > Math.ceil(IMAGE_LIMIT_BYTES / 3) * 4
    || canonical.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(canonical)) {
    throw new Error("invalid_image_base64");
  }
  const bytes = Buffer.from(canonical, "base64");
  if (!bytes.length || bytes.length > IMAGE_LIMIT_BYTES
    || bytes.toString("base64").replace(/=+$/g, "") !== canonical.replace(/=+$/g, "")) {
    throw new Error("invalid_image_base64_or_size");
  }
  const mimeType = detectImageMime(bytes);
  if (!mimeType || !IMAGE_EXTENSIONS[mimeType] || mimeType !== declaredMime.toLowerCase()) {
    throw new Error("invalid_image_mime");
  }
  return { bytes, mimeType };
}

/**
 * Synchronous atomic files keep the raw MCP result durable before the model
 * can continue. A separate file per event avoids a partial JSONL tail after a
 * crash, while date directories keep ordinary history queries bounded.
 */
export class ComputerUseHistoryStore {
  readonly root: string;
  private readonly eventsRoot: string;
  private readonly assetsRoot: string;
  private orderInitialized = false;
  private lastLogicalMs = 0;
  private lastSequence = 0;

  constructor(root = path.join(getDataDir(), "computer-use-history")) {
    this.root = path.resolve(root);
    this.eventsRoot = path.join(this.root, "events");
    this.assetsRoot = path.join(this.root, "assets");
  }

  private ensurePrivateDirectory(directory: string): void {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  }

  private eventFile(id: string): string | null {
    const day = timestampFromId(id);
    return day ? path.join(this.eventsRoot, day, `${id}.json`) : null;
  }

  private recordedPromptId(identity: string): string | null {
    try {
      for (const day of fs.readdirSync(this.eventsRoot).sort().reverse()) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        const id = `${day}-p-${identity}`;
        if (this.getEvent(id)?.kind === "prompt") return id;
      }
    } catch {
      // The history directory has not been created yet.
    }
    return null;
  }

  private nextOrderKey(): string {
    if (!this.orderInitialized) {
      for (const event of this.readEvents()) {
        const match = /^(\d{13})-(\d{12})-[a-f0-9]{8}$/.exec(event.orderKey);
        if (!match) continue;
        const logicalMs = Number(match[1]);
        const sequence = Number(match[2]);
        if (logicalMs > this.lastLogicalMs || (logicalMs === this.lastLogicalMs && sequence > this.lastSequence)) {
          this.lastLogicalMs = logicalMs;
          this.lastSequence = sequence;
        }
      }
      this.orderInitialized = true;
    }
    const now = Date.now();
    if (now > this.lastLogicalMs) {
      this.lastLogicalMs = now;
      this.lastSequence = 0;
    } else {
      this.lastSequence += 1;
      if (this.lastSequence > 999_999_999_999) {
        this.lastLogicalMs += 1;
        this.lastSequence = 0;
      }
    }
    return `${String(this.lastLogicalMs).padStart(13, "0")}-${String(this.lastSequence).padStart(12, "0")}-${crypto.randomBytes(4).toString("hex")}`;
  }

  private newEvent(input: Omit<ComputerUseHistoryEvent, "id" | "orderKey">, id?: string): ComputerUseHistoryEvent {
    return {
      ...input,
      id: id ?? `${input.timestamp.slice(0, 10)}-${crypto.randomUUID()}`,
      orderKey: this.nextOrderKey(),
    };
  }

  private writeAtomicFile(file: string, data: string | Buffer): void {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      const descriptor = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, data);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporary, file);
    } finally {
      // Also remove a partial temp file if write or fsync failed before rename.
      try { fs.unlinkSync(temporary); } catch { /* Rename consumed it or open failed. */ }
    }
  }

  private writeEvent(event: ComputerUseHistoryEvent): void {
    const file = this.eventFile(event.id);
    if (!file) throw new Error("invalid_history_event_id");
    this.ensurePrivateDirectory(this.root);
    this.ensurePrivateDirectory(this.eventsRoot);
    this.ensurePrivateDirectory(path.dirname(file));
    this.writeAtomicFile(file, JSON.stringify(event));
  }

  private saveImage(data: string, declaredMime: string): ComputerUseScreenshot {
    const { bytes, mimeType } = validatedImage(data, declaredMime);
    const assetId = digest(bytes);
    this.ensurePrivateDirectory(this.root);
    this.ensurePrivateDirectory(this.assetsRoot);
    const file = path.join(this.assetsRoot, `${assetId}${IMAGE_EXTENSIONS[mimeType]}`);
    if (!fs.existsSync(file) || !fs.readFileSync(file).equals(bytes)) this.writeAtomicFile(file, bytes);
    return { assetId, mimeType, sizeBytes: bytes.length };
  }

  recordPrompt(context: ComputerUseRecordContext): string | null {
    const text = context.promptText;
    if (typeof text !== "string" || !text.length) return null;
    const sessionId = context.sessionId ?? null;
    const turnId = context.turnId ?? null;
    const capturedAt = new Date().toISOString();
    const proposedTimestamp = context.promptTimestamp;
    const hasMessageTimestamp = typeof proposedTimestamp === "string"
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(proposedTimestamp)
      && Number.isFinite(Date.parse(proposedTimestamp))
      && new Date(proposedTimestamp).toISOString() === proposedTimestamp;
    const timestamp = hasMessageTimestamp ? proposedTimestamp! : capturedAt;
    // A steered user message can share a turn with the original prompt. Its
    // message ID must take precedence so later tool calls can point to it.
    const stableMessageId = context.messageId ?? turnId ?? null;
    const identity = stableMessageId
      ? digest(JSON.stringify([sessionId, stableMessageId])).slice(0, 40)
      : crypto.randomBytes(20).toString("hex");
    if (stableMessageId) {
      const existing = this.recordedPromptId(identity);
      if (existing) return existing;
    }
    const id = `${timestamp.slice(0, 10)}-p-${identity}`;
    this.writeEvent(this.newEvent({
      kind: "prompt",
      timestamp,
      title: "User prompt",
      summary: compactPreview(text),
      source: "recorder",
      sessionId,
      completeness: "complete",
      missingReason: null,
      metadata: {
        turnId,
        messageId: context.messageId ?? null,
        channel: context.channel ?? null,
        chatId: context.chatId ?? null,
        capturedAt,
        timestampSource: hasMessageTimestamp ? "message" : "capture",
      },
      parentId: null,
      text,
      args: null,
      result: null,
      screenshot: null,
    }, id));
    return id;
  }

  startToolCall(input: {
    server: string;
    toolName: string;
    args: Record<string, unknown>;
    callId?: string | null;
    managed?: boolean;
    attemptIndex?: number;
    context?: ComputerUseRecordContext | null;
  }): ComputerUseCallHandle {
    const context = input.context ?? {};
    const promptId = this.recordPrompt(context);
    const timestamp = new Date().toISOString();
    const event = this.newEvent({
      kind: "tool_call",
      timestamp,
      title: input.toolName,
      summary: `${input.server}.${input.toolName} (pending)`,
      source: "recorder",
      sessionId: context.sessionId ?? null,
      completeness: "partial",
      missingReason: "tool_result_pending",
      metadata: {
        server: input.server,
        toolName: input.toolName,
        callId: input.callId ?? null,
        managed: input.managed === true,
        attemptIndex: input.attemptIndex ?? 1,
        turnId: context.turnId ?? null,
        messageId: context.messageId ?? null,
        status: "pending",
        attemptCount: 0,
        dispatched: null,
        resultObserved: null,
        textBlockCount: null,
        screenshotCount: null,
      },
      parentId: promptId,
      text: null,
      args: jsonSafe(input.args) as Record<string, unknown>,
      result: null,
      screenshot: null,
    });
    this.writeEvent(event);
    return { id: event.id, startedAtMs: Date.now() };
  }

  finishToolCall(handle: ComputerUseCallHandle, rawResult: unknown, outcome: ComputerUseCallOutcome = {}): ComputerUseHistoryEvent | null {
    const call = this.getEvent(handle.id);
    if (!call || call.kind !== "tool_call") return null;
    const finishedAt = new Date().toISOString();
    const resultObject = rawResult && typeof rawResult === "object" && !Array.isArray(rawResult)
      ? rawResult as Record<string, unknown>
      : null;
    const resultObserved = rawResult !== null && rawResult !== undefined;
    const content = Array.isArray(resultObject?.content) ? resultObject.content : [];
    const evidenceIds: string[] = [];
    let missingImage = false;
    let imageIndex = 0;
    let textIndex = 0;
    const storedContent = content.map((block, blockIndex) => {
      const evidenceTimestamp = finishedAt;
      if (!block || typeof block !== "object" || Array.isArray(block)) return jsonSafe(block);
      const item = block as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") {
        textIndex += 1;
        const safeItemText = redactComputerUseImagePayloads(item.text, "text");
        const textEvent = this.newEvent({
          kind: "ui_text",
          timestamp: evidenceTimestamp,
          title: `${String(call.metadata.toolName)} output ${textIndex}`,
          summary: compactPreview(safeItemText),
          source: "recorder",
          sessionId: call.sessionId,
          completeness: "complete",
          missingReason: null,
          metadata: {
            toolName: call.metadata.toolName,
            callId: call.metadata.callId,
            turnId: call.metadata.turnId ?? null,
            blockIndex,
          },
          parentId: call.id,
          text: safeItemText,
          args: null,
          result: null,
          screenshot: null,
        });
        this.writeEvent(textEvent);
        evidenceIds.push(textEvent.id);
        return jsonSafe(item);
      }
      if (item.type === "image") {
        imageIndex += 1;
        let screenshot: ComputerUseScreenshot | null = null;
        try {
          if (typeof item.data !== "string" || typeof item.mimeType !== "string") throw new Error("image_content_missing");
          screenshot = this.saveImage(item.data, item.mimeType);
        } catch {
          missingImage = true;
        }
        const imageEvent = this.newEvent({
          kind: "screenshot",
          timestamp: evidenceTimestamp,
          title: `${String(call.metadata.toolName)} screenshot ${imageIndex}`,
          summary: screenshot ? `${screenshot.mimeType}, ${screenshot.sizeBytes} bytes` : "Image unavailable",
          source: "recorder",
          sessionId: call.sessionId,
          completeness: screenshot ? "complete" : "partial",
          missingReason: screenshot ? null : "invalid_or_unavailable_image",
          metadata: {
            toolName: call.metadata.toolName,
            callId: call.metadata.callId,
            turnId: call.metadata.turnId ?? null,
            blockIndex,
          },
          parentId: call.id,
          text: null,
          args: null,
          result: null,
          screenshot,
        });
        this.writeEvent(imageEvent);
        evidenceIds.push(imageEvent.id);
        return {
          type: "image",
          mimeType: screenshot?.mimeType ?? item.mimeType ?? null,
          assetId: screenshot?.assetId ?? null,
          unavailable: !screenshot,
        };
      }
      return jsonSafe(item);
    });
    let result: unknown | null = null;
    if (resultObject) {
      const { content: _ignored, ...rest } = resultObject;
      result = { ...(jsonSafe(rest) as Record<string, unknown>), content: storedContent };
    } else if (rawResult !== undefined && rawResult !== null) {
      result = jsonSafe(rawResult);
    }
    const status = outcome.status ?? (resultObject?.isError === true ? "error" : "ok");
    const definiteWithoutResult = status === "blocked" || (status === "cancelled" && outcome.dispatched === false);
    const completeness = !missingImage && (result !== null || definiteWithoutResult)
      && status !== "uncertain" && status !== "timeout"
      ? "complete" : "partial";
    const missingReason = missingImage
      ? "invalid_or_unavailable_image"
      : status === "uncertain" ? "tool_outcome_unknown"
      : status === "timeout" ? "tool_result_timeout"
      : completeness === "partial" ? "tool_result_unavailable"
      : null;
    const firstText = content.find((item): item is { type: "text"; text: string } => (
      Boolean(item && typeof item === "object" && (item as any).type === "text" && typeof (item as any).text === "string")
    ))?.text;
    const next: ComputerUseHistoryEvent = {
      ...call,
      summary: firstText ? compactPreview(redactComputerUseImagePayloads(firstText, "text")) : `${String(call.metadata.toolName)}: ${status}`,
      completeness,
      missingReason,
      metadata: {
        ...call.metadata,
        status,
        attemptCount: outcome.attemptCount ?? 1,
        dispatched: outcome.dispatched ?? null,
        resultObserved,
        durationMs: Math.max(0, Date.now() - handle.startedAtMs),
        isError: resultObject?.isError === true,
        error: outcome.error ?? null,
        evidenceIds,
        textBlockCount: resultObserved ? textIndex : null,
        screenshotCount: resultObserved ? imageIndex : null,
      },
      result,
    };
    this.writeEvent(next);
    return next;
  }

  getEvent(id: string): ComputerUseHistoryEvent | null {
    const file = this.eventFile(id);
    if (!file) return null;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size <= 0 || stat.size > EVENT_LIMIT_BYTES) return null;
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!recordObject(parsed) || parsed.id !== id || parsed.source !== "recorder"
        || !["prompt", "tool_call", "ui_text", "screenshot"].includes(String(parsed.kind))
        || typeof parsed.timestamp !== "string" || !Number.isFinite(Date.parse(parsed.timestamp))
        || typeof parsed.title !== "string" || typeof parsed.summary !== "string"
        || !nullableString(parsed.sessionId)
        || (parsed.completeness !== "complete" && parsed.completeness !== "partial")
        || !nullableString(parsed.missingReason) || !recordObject(parsed.metadata)
        || !nullableString(parsed.parentId) || !nullableString(parsed.text)
        || !(parsed.args === null || recordObject(parsed.args))
        || !Object.hasOwn(parsed, "result")) return null;
      const orderKey = parsed.orderKey ?? `${String(Date.parse(parsed.timestamp)).padStart(13, "0")}-000000000000-${digest(id).slice(0, 8)}`;
      if (typeof orderKey !== "string" || !ORDER_KEY.test(orderKey)) return null;
      let screenshot: ComputerUseScreenshot | null = null;
      if (parsed.screenshot !== null) {
        if (!recordObject(parsed.screenshot) || typeof parsed.screenshot.assetId !== "string"
          || !ASSET_ID.test(parsed.screenshot.assetId)
          || typeof parsed.screenshot.mimeType !== "string"
          || !IMAGE_EXTENSIONS[parsed.screenshot.mimeType]
          || !Number.isSafeInteger(parsed.screenshot.sizeBytes)
          || (parsed.screenshot.sizeBytes as number) < 0
          || (parsed.screenshot.sizeBytes as number) > IMAGE_LIMIT_BYTES) return null;
        screenshot = {
          assetId: parsed.screenshot.assetId,
          mimeType: parsed.screenshot.mimeType,
          sizeBytes: parsed.screenshot.sizeBytes as number,
        };
      }
      // Rebuild the public shape so extra fields in an old or damaged file
      // cannot leak into the strict HTTP response schema.
      return {
        id,
        kind: parsed.kind as ComputerUseHistoryKind,
        timestamp: parsed.timestamp,
        orderKey,
        title: parsed.title,
        summary: parsed.summary,
        source: "recorder",
        sessionId: parsed.sessionId,
        completeness: parsed.completeness,
        missingReason: parsed.missingReason,
        metadata: parsed.metadata,
        parentId: parsed.parentId,
        text: parsed.text,
        args: parsed.args as Record<string, unknown> | null,
        result: parsed.result ?? null,
        screenshot,
      };
    } catch {
      return null;
    }
  }

  readEvents(): ComputerUseHistoryEvent[] {
    if (!fs.existsSync(this.eventsRoot)) return [];
    const rows: ComputerUseHistoryEvent[] = [];
    for (const day of fs.readdirSync(this.eventsRoot)) {
      if (Number.isNaN(Date.parse(`${day}T00:00:00.000Z`))) continue;
      const directory = path.join(this.eventsRoot, day);
      try {
        if (!fs.lstatSync(directory).isDirectory()) continue;
        for (const name of fs.readdirSync(directory)) {
          if (!name.endsWith(".json")) continue;
          const event = this.getEvent(name.slice(0, -5));
          if (event) rows.push(event);
        }
      } catch {
        continue;
      }
    }
    return rows;
  }

  readAsset(assetId: string): { mimeType: string; dataBase64: string } {
    if (!ASSET_ID.test(assetId)) throw new ComputerUseHistoryError(404, "asset_not_found");
    for (const [mimeType, extension] of Object.entries(IMAGE_EXTENSIONS)) {
      const file = path.join(this.assetsRoot, `${assetId}${extension}`);
      try {
        if (!fs.lstatSync(file).isFile()) throw new ComputerUseHistoryError(410, "asset_expired");
        const bytes = fs.readFileSync(file);
        if (bytes.length > IMAGE_LIMIT_BYTES || digest(bytes) !== assetId || detectImageMime(bytes) !== mimeType) {
          throw new ComputerUseHistoryError(410, "asset_corrupt");
        }
        return { mimeType, dataBase64: bytes.toString("base64") };
      } catch (error) {
        if (error instanceof ComputerUseHistoryError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ComputerUseHistoryError(410, "asset_expired");
      }
    }
    throw new ComputerUseHistoryError(404, "asset_not_found");
  }
}

export function summaryFromEvent(event: ComputerUseHistoryEvent): ComputerUseHistorySummary {
  const { text: _text, args: _args, result: _result, screenshot: _screenshot, ...summary } = event;
  return summary;
}
