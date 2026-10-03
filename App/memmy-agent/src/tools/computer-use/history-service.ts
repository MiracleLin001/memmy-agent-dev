import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "../../config/paths.js";
import { detectImageMime, extractReasoning } from "../../utils/helpers.js";
import {
  ComputerUseHistoryError,
  ComputerUseHistoryStore,
  redactComputerUseImagePayloads,
  summaryFromEvent,
  type ComputerUseHistoryEvent,
  type ComputerUseHistoryKind,
  type ComputerUseHistorySummary,
  type ComputerUseScreenshot,
} from "./history-store.js";

type Message = Record<string, any>;
type SessionRecord = {
  key: string;
  messages: Message[];
  createdAt?: string;
  updatedAt?: string;
};
export type ComputerUseSessionReader = {
  listSessionRecords(): SessionRecord[];
};
export interface ComputerUseHistoryQuery {
  limit?: number;
  cursor?: string | null;
  from?: string | null;
  to?: string | null;
  kind?: ComputerUseHistoryKind | null;
  sessionId?: string | null;
  turnId?: string | null;
}
export interface ComputerUseHistoryPage {
  events: ComputerUseHistorySummary[];
  nextCursor: string | null;
}

const OCU_TOOL_SUFFIX = /^(?:list_apps|get_app_state|click|drag|perform_secondary_action|press_key|scroll|set_value|type_text)$/;
const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024;
const MAX_LEGACY_IMAGE_BYTES = 20 * 1024 * 1024;
const LEGACY_IMAGE_PATTERN = /\[image(?::\s*([^\]]+))?\]/g;
const LEGACY_REASONING_TEXT_LIMIT = 8_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toolName(call: unknown): string | null {
  if (!isRecord(call)) return null;
  const fn = isRecord(call.function) ? call.function : null;
  const name = fn?.name ?? call.name;
  return typeof name === "string" && name.trim() ? name : null;
}

export function isComputerUseToolName(name: string): boolean {
  if (name === "get_screen_state") return true;
  const lower = name.toLowerCase();
  if (!lower.startsWith("mcp_open_computer_use_")) return false;
  return OCU_TOOL_SUFFIX.test(lower.slice("mcp_open_computer_use_".length));
}

function stableId(source: "s" | "t", fields: unknown[]): string {
  return `legacy-${source}-${crypto.createHash("sha256").update(JSON.stringify(fields)).digest("hex").slice(0, 48)}`;
}

function legacyOrderKey(timestamp: string, orderIndex: number, id: string): string {
  const millis = Date.parse(timestamp);
  return `${String(Number.isFinite(millis) ? millis : 0).padStart(13, "0")}-${String(Math.min(999_999_999_999, orderIndex)).padStart(12, "0")}-${crypto.createHash("sha256").update(id).digest("hex").slice(0, 8)}`;
}

function dateString(value: unknown, fallback: unknown = null): string {
  for (const candidate of [value, fallback]) {
    const number = typeof candidate === "number"
      ? (candidate > 10_000_000_000 ? candidate : candidate * 1000)
      : NaN;
    const parsed = Number.isFinite(number)
      ? new Date(number)
      : typeof candidate === "string" ? new Date(candidate) : null;
    if (parsed && !Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date(0).toISOString();
}

function preview(text: string, limit = 180): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
}

function parsedArgs(raw: unknown): Record<string, unknown> | null {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) return parsed;
  } catch {
    // A malformed legacy argument string is still evidence and is shown as-is.
  }
  return { raw };
}

function legacyUserText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.filter((block: unknown) => isRecord(block) && typeof block.text === "string")
      .map((block: any) => block.text).join("\n");
  }
  return "";
}

function normalizeLegacyReasoning(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalized.length <= LEGACY_REASONING_TEXT_LIMIT
    ? normalized
    : `${normalized.slice(0, LEGACY_REASONING_TEXT_LIMIT - 1).trimEnd()}…`;
}

function legacyAssistantReasoning(message: Message): string {
  const content = typeof message.content === "string" ? message.content : legacyUserText(message);
  const thinkingBlocks = Array.isArray(message.thinking_blocks) ? message.thinking_blocks : null;
  const [reasoning] = extractReasoning(
    typeof message.reasoning_content === "string" ? message.reasoning_content : null,
    thinkingBlocks,
    content,
  );
  const directField = [
    message.reasoningSummary,
    message.reasoning_summary,
    message.thinkingBefore,
    message.thinking_before,
    message.reasoning,
  ].find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return normalizeLegacyReasoning(reasoning || directField);
}

function appendReasoningText(existing: string, next: string): string {
  const current = normalizeLegacyReasoning(existing);
  const incoming = normalizeLegacyReasoning(next);
  if (!current) return incoming;
  if (!incoming || current === incoming || current.endsWith(incoming)) return current;
  if (incoming.startsWith(current)) return incoming;
  return normalizeLegacyReasoning(`${current}${incoming}`);
}

type LegacyEvidence =
  | { kind: "ui_text"; text: string; blockIndex: number }
  | { kind: "screenshot"; imagePath: string | null; blockIndex: number };

function legacyEvidence(value: unknown, files: string[] = []): LegacyEvidence[] {
  const evidence: LegacyEvidence[] = [];
  const imagePaths = new Set<string>();
  const addImage = (imagePath: string | null) => {
    evidence.push({ kind: "screenshot", imagePath, blockIndex: evidence.length });
    if (imagePath) imagePaths.add(imagePath);
  };
  const addText = (text: string) => {
    if (text.trim()) evidence.push({
      kind: "ui_text", text: redactComputerUseImagePayloads(text, "text"), blockIndex: evidence.length,
    });
  };
  const splitText = (text: string) => {
    let start = 0;
    for (const match of text.matchAll(LEGACY_IMAGE_PATTERN)) {
      const markerStart = match.index ?? start;
      addText(text.slice(start, markerStart));
      addImage(match[1]?.trim() || null);
      start = markerStart + match[0].length;
    }
    addText(text.slice(start));
  };
  if (typeof value === "string") splitText(value);
  if (Array.isArray(value)) {
    for (const block of value) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") splitText(block.text);
      else if (block.type === "image_url") {
        addImage(typeof (block.meta as any)?.path === "string" ? (block.meta as any).path : null);
      }
    }
  }
  // Transcript file attachments have no position in the content stream. Put
  // only unmatched references after ordered content evidence.
  for (const file of files) if (!imagePaths.has(file)) addImage(file);
  return evidence;
}

function withoutImagePaths(value: unknown): unknown {
  if (typeof value === "string") {
    if (/^file:\/\//i.test(value)) return "[image reference]";
    return redactComputerUseImagePayloads(value.replace(LEGACY_IMAGE_PATTERN, "[image reference]"));
  }
  if (Array.isArray(value)) return value.map(withoutImagePaths);
  if (!isRecord(value)) return value ?? null;
  if (value.type === "image_url" && isRecord(value.image_url)) {
    return { type: "image_url", image_url: { url: "[image reference]" } };
  }
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "meta" && key !== "files")
    .map(([key, item]) => [key, withoutImagePaths(item)]));
}

function comparableCallId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function withinDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function legacyEvent(
  source: "session" | "transcript",
  id: string,
  kind: ComputerUseHistoryKind,
  timestamp: string,
  orderIndex: number,
  sessionId: string,
  title: string,
  summary: string,
  missingReason: string,
  metadata: Record<string, unknown>,
  parentId: string | null,
  detail: Partial<Pick<ComputerUseHistoryEvent, "text" | "args" | "result" | "screenshot">> = {},
): ComputerUseHistoryEvent {
  return {
    id, kind, timestamp, orderKey: legacyOrderKey(timestamp, orderIndex, id), title, summary, source, sessionId,
    completeness: "partial", missingReason, metadata, parentId,
    text: detail.text ?? null,
    args: detail.args ?? null,
    result: detail.result ?? null,
    screenshot: detail.screenshot ?? null,
  };
}

type LegacyReasoning = {
  text: string;
  timestamp: string;
  key: string;
  turnId: string | null;
  orderIndex: number;
};

type LegacyCall = {
  source: "session" | "transcript";
  sessionId: string;
  key: string;
  timestamp: string;
  name: string;
  callId: string | null;
  turnId: string | null;
  args: Record<string, unknown> | null;
  result: unknown;
  resultMissing: boolean;
  error: string | null;
  prompt: { text: string; timestamp: string; key: string; turnId: string | null; orderIndex: number } | null;
  reasoning: LegacyReasoning | null;
  orderIndex: number;
  evidence: LegacyEvidence[];
};

function legacyReasoningEvent(
  call: LegacyCall,
  parentId: string | null,
): ComputerUseHistoryEvent | null {
  const reasoning = call.reasoning;
  if (!reasoning?.text) return null;
  const sourceCode = call.source === "session" ? "s" : "t";
  const id = stableId(sourceCode, [call.sessionId, "reasoning", reasoning.key, reasoning.text]);
  return legacyEvent(
    call.source, id, "reasoning", reasoning.timestamp, reasoning.orderIndex, call.sessionId,
    "Agent reasoning summary", preview(reasoning.text),
    call.source === "session" ? "legacy_reasoning_may_be_truncated" : "transcript_reasoning_is_sanitized",
    {
      toolName: call.name,
      callId: call.callId,
      turnId: call.turnId ?? reasoning.turnId,
      origin: call.source,
      reasoningId: id,
    },
    parentId,
    { text: reasoning.text },
  );
}

function legacyCallIdentity(call: LegacyCall): string | null {
  return call.callId ? `${call.sessionId}\0${call.callId}` : null;
}

function legacyCallQuality(call: LegacyCall): [number, number, number, number] {
  return [
    call.result != null ? 2 : call.error ? 1 : 0,
    call.evidence.filter((item) => item.kind === "screenshot" && item.imagePath).length,
    call.evidence.length,
    call.evidence.reduce((length, item) => length + (item.kind === "ui_text" ? item.text.length : 0), 0),
  ];
}

function hasBetterLegacyEvidence(candidate: LegacyCall, previous: LegacyCall): boolean {
  const candidateQuality = legacyCallQuality(candidate);
  const previousQuality = legacyCallQuality(previous);
  for (let index = 0; index < candidateQuality.length; index += 1) {
    if (candidateQuality[index] !== previousQuality[index]) {
      return candidateQuality[index] > previousQuality[index];
    }
  }
  return false;
}

function preferredLegacyCalls(calls: LegacyCall[]): LegacyCall[] {
  const byIdentity = new Map<string, LegacyCall>();
  const withoutCallId: LegacyCall[] = [];
  for (const call of calls) {
    const identity = legacyCallIdentity(call);
    if (!identity) {
      withoutCallId.push(call);
      continue;
    }
    const previous = byIdentity.get(identity);
    if (!previous) {
      byIdentity.set(identity, call);
      continue;
    }
    if (hasBetterLegacyEvidence(call, previous)) byIdentity.set(identity, call);
  }
  return [...byIdentity.values(), ...withoutCallId];
}

function hasLegacyResultEvidence(call: LegacyCall): boolean {
  return call.result != null || call.error != null || call.evidence.length > 0;
}

function recorderNeedsRecovery(event: ComputerUseHistoryEvent): boolean {
  return event.kind === "tool_call" && event.completeness === "partial"
    && (event.metadata.status === "pending" || event.result == null || event.metadata.resultObserved === false);
}

function recoveryOrderKey(recorder: ComputerUseHistoryEvent, timestamp: string, index: number, id: string): string {
  const recordedMs = Number(recorder.orderKey.slice(0, 13));
  const legacyMs = Date.parse(timestamp);
  const logicalMs = Math.max(recordedMs + 1, Number.isFinite(legacyMs) ? legacyMs : 0);
  return `${String(logicalMs).padStart(13, "0")}-${String(index + 1).padStart(12, "0")}-${crypto.createHash("sha256").update(id).digest("hex").slice(0, 8)}`;
}

function callsFromSessions(reader: ComputerUseSessionReader | null): LegacyCall[] {
  if (!reader) return [];
  let sessions: SessionRecord[];
  try { sessions = reader.listSessionRecords(); } catch { return []; }
  const calls: LegacyCall[] = [];
  for (const session of sessions) {
    if (!session?.key || !Array.isArray(session.messages)) continue;
    const resultById = new Map<string, Message>();
    for (const message of session.messages) {
      const id = comparableCallId(message?.tool_call_id);
      if (message?.role === "tool" && id && !resultById.has(id)) resultById.set(id, message);
    }
    let currentPrompt: LegacyCall["prompt"] = null;
    for (const [index, message] of session.messages.entries()) {
      if (message?.role === "user" && message.internal_context !== "goal_continuation") {
        const text = legacyUserText(message);
        currentPrompt = text ? {
          text,
          timestamp: dateString(message.timestamp, session.createdAt),
          key: `${session.key}:${index}`,
          turnId: comparableCallId(message.turn_id ?? message.turnId),
          orderIndex: index * 1_000_000,
        } : null;
      }
      if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
      const assistantReasoning = legacyAssistantReasoning(message);
      for (const [callIndex, call] of message.tool_calls.entries()) {
        const name = toolName(call);
        if (!name || !isComputerUseToolName(name)) continue;
        const callId = comparableCallId(call.id);
        const resultMessage = callId ? resultById.get(callId) : null;
        const result = resultMessage?.content ?? null;
        const explicitTurnId = comparableCallId(message.turn_id ?? message.turnId);
        const matchedPrompt = explicitTurnId && currentPrompt?.turnId && explicitTurnId !== currentPrompt.turnId
          ? null : currentPrompt;
        const reasoningTurnId = explicitTurnId ?? matchedPrompt?.turnId ?? null;
        const timestamp = dateString(message.timestamp, matchedPrompt?.timestamp ?? session.createdAt);
        calls.push({
          source: "session",
          sessionId: session.key,
          key: `${session.key}:${index}:${callIndex}`,
          orderIndex: index * 1_000_000 + callIndex * 1_000,
          timestamp,
          name,
          callId,
          turnId: reasoningTurnId,
          args: parsedArgs((call as any)?.function?.arguments ?? (call as any)?.arguments),
          result,
          resultMissing: resultMessage == null,
          error: null,
          prompt: matchedPrompt,
          reasoning: assistantReasoning ? {
            text: assistantReasoning,
            timestamp,
            key: `${session.key}:${index}:reasoning`,
            turnId: reasoningTurnId,
            orderIndex: index * 1_000_000 + 1,
          } : null,
          evidence: legacyEvidence(result),
        });
      }
    }
  }
  return calls;
}

function transcriptCreatedAt(record: Message, fallback: string): string {
  return dateString(record.createdAt ?? record.created_at ?? record.timestamp, fallback);
}

function callsFromTranscripts(root: string): LegacyCall[] {
  let names: string[];
  try { names = fs.readdirSync(root).filter((name) => name.startsWith("websocket_") && name.endsWith(".jsonl")); }
  catch { return []; }
  const calls: LegacyCall[] = [];
  for (const name of names) {
    const file = path.join(root, name);
    let lines: Message[] = [];
    let fallback: string;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) continue;
      fallback = stat.mtime.toISOString();
      lines = fs.readFileSync(file, "utf8").split(/\r?\n/).flatMap((raw) => {
        try {
          const parsed: unknown = JSON.parse(raw);
          return isRecord(parsed) ? [parsed as Message] : [];
        } catch { return []; }
      });
    } catch { continue; }
    const sessionId = `websocket:${name.slice("websocket_".length, -".jsonl".length)}`;
    let currentPrompt: LegacyCall["prompt"] = null;
    const promptByTurn = new Map<string, NonNullable<LegacyCall["prompt"]>>();
    const reasoningByTurn = new Map<string, LegacyReasoning>();
    let unkeyedReasoning: LegacyReasoning | null = null;
    const grouped = new Map<string, LegacyCall>();
    for (const [lineIndex, record] of lines.entries()) {
      const timestamp = transcriptCreatedAt(record, fallback);
      const turnId = comparableCallId(record.turn_id ?? record.turnId);
      if (record.event === "user") {
        const text = typeof record.text === "string" ? record.text : typeof record.content === "string" ? record.content : "";
        currentPrompt = text ? {
          text, timestamp, key: `${name}:${record.transcript_offset ?? lineIndex}`,
          turnId, orderIndex: lineIndex * 1_000_000,
        } : null;
        if (turnId && currentPrompt) promptByTurn.set(turnId, currentPrompt);
      }
      if (record.event === "reasoning_delta") {
        const text = normalizeLegacyReasoning(record.text);
        if (text) {
          const key = turnId ? `${name}:turn:${turnId}` : `${name}:line:${lineIndex}`;
          const existing = turnId ? reasoningByTurn.get(turnId) : unkeyedReasoning;
          if (existing) {
            existing.text = appendReasoningText(existing.text, text);
          } else {
            const next: LegacyReasoning = {
              text,
              timestamp,
              key,
              turnId,
              orderIndex: lineIndex * 1_000_000 + 1,
            };
            if (turnId) reasoningByTurn.set(turnId, next);
            else unkeyedReasoning = next;
          }
        }
      }
      if (!Array.isArray(record.tool_events)) continue;
      for (const [eventIndex, item] of record.tool_events.entries()) {
        if (!isRecord(item)) continue;
        const nameValue = toolName(item);
        if (!nameValue || !isComputerUseToolName(nameValue)) continue;
        const callId = comparableCallId(item.call_id ?? item.ui_tool_call_id);
        const key = callId ? `${sessionId}:${callId}` : `${sessionId}:${lineIndex}:${eventIndex}`;
        const existing = grouped.get(key);
        const rawResult = item.result ?? null;
        const files = Array.isArray(item.files)
          ? item.files.filter((value): value is string => typeof value === "string")
          : [];
        const evidence = legacyEvidence(rawResult, files);
        const reasoning = (turnId ? reasoningByTurn.get(turnId) : null)
          ?? (turnId && currentPrompt?.turnId === turnId ? unkeyedReasoning : null)
          ?? (!turnId ? unkeyedReasoning : null);
        if (!existing) {
          grouped.set(key, {
            source: "transcript",
            sessionId,
            key,
            orderIndex: lineIndex * 1_000_000 + eventIndex * 1_000,
            timestamp,
            name: nameValue,
            callId,
            turnId: turnId ?? currentPrompt?.turnId ?? null,
            args: parsedArgs(item.arguments ?? (item.function as any)?.arguments),
            result: rawResult,
            resultMissing: rawResult == null,
            error: typeof item.error === "string" ? item.error : null,
            prompt: turnId ? promptByTurn.get(turnId) ?? null : currentPrompt,
            reasoning,
            evidence,
          });
        } else {
          if (rawResult != null) {
            existing.result = rawResult;
            existing.resultMissing = false;
            existing.evidence = evidence;
          }
          if (typeof item.error === "string") existing.error = item.error;
          if (rawResult == null && evidence.length) existing.evidence = evidence;
          if (!existing.args) existing.args = parsedArgs(item.arguments ?? (item.function as any)?.arguments);
          if (!existing.turnId && turnId) {
            existing.turnId = turnId;
            existing.prompt = promptByTurn.get(turnId) ?? null;
          }
          if (!existing.reasoning && reasoning) existing.reasoning = reasoning;
        }
      }
    }
    calls.push(...grouped.values());
  }
  return calls;
}

function cursorTuple(cursor: string | null | undefined): [string, string] | null {
  if (!cursor) return null;
  if (cursor.length > 1000) throw new ComputerUseHistoryError(400, "invalid_cursor");
  let parsed: unknown;
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw new Error("noncanonical");
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch { throw new ComputerUseHistoryError(400, "invalid_cursor"); }
  if (!Array.isArray(parsed) || parsed.length !== 2
    || typeof parsed[0] !== "string" || typeof parsed[1] !== "string"
    || !/^\d{13}-\d{12}-[a-f0-9]{8}$/.test(parsed[0]) || !parsed[1]) {
    throw new ComputerUseHistoryError(400, "invalid_cursor");
  }
  return [parsed[0], parsed[1]];
}

function validatedBound(value: string | null | undefined, name: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ComputerUseHistoryError(400, `invalid_${name}`);
  return date.toISOString();
}

function newerFirst(left: ComputerUseHistoryEvent, right: ComputerUseHistoryEvent): number {
  return right.orderKey.localeCompare(left.orderKey) || right.id.localeCompare(left.id);
}

/**
 * Read-only merged view of newly recorded evidence and the partial evidence
 * already present in Memmy session JSONL / WebUI transcripts.
 */
export class ComputerUseHistoryService {
  readonly store: ComputerUseHistoryStore;
  private readonly sessions: ComputerUseSessionReader | null;
  private readonly transcriptsRoot: string;
  private readonly legacyMediaRoot: string;
  private readonly legacyImageCache = new Map<string, { signature: string; ref: ComputerUseScreenshot }>();

  constructor(input: {
    store?: ComputerUseHistoryStore;
    sessions?: ComputerUseSessionReader | null;
    transcriptsRoot?: string;
    legacyMediaRoot?: string;
  } = {}) {
    this.store = input.store ?? new ComputerUseHistoryStore();
    this.sessions = input.sessions ?? null;
    this.transcriptsRoot = path.resolve(input.transcriptsRoot ?? path.join(getDataDir(), "webui"));
    this.legacyMediaRoot = path.resolve(input.legacyMediaRoot ?? path.join(getDataDir(), "media", "tool-results"));
  }

  private legacyImage(assetPath: string | null, includeBytes = false): {
    ref: ComputerUseScreenshot | null;
    pathHash: string | null;
    reason: string;
    bytes: Buffer | null;
  } {
    if (!assetPath || !path.isAbsolute(assetPath)) {
      return { ref: null, pathHash: null, reason: "legacy_image_path_missing", bytes: null };
    }
    const resolved = path.resolve(assetPath);
    if (!withinDirectory(this.legacyMediaRoot, resolved)) {
      return { ref: null, pathHash: null, reason: "legacy_image_outside_tool_media", bytes: null };
    }
    const pathHash = crypto.createHash("sha256").update(resolved).digest("hex");
    try {
      const mediaReal = fs.realpathSync(this.legacyMediaRoot);
      const actual = fs.realpathSync(resolved);
      if (!withinDirectory(mediaReal, actual) || !fs.lstatSync(resolved).isFile()) {
        return { ref: null, pathHash, reason: "legacy_image_outside_tool_media", bytes: null };
      }
      const stat = fs.statSync(resolved);
      if (stat.size <= 0 || stat.size > MAX_LEGACY_IMAGE_BYTES) {
        this.legacyImageCache.delete(resolved);
        return { ref: null, pathHash, reason: "legacy_image_unavailable", bytes: null };
      }
      const signature = `${actual}\0${stat.dev}\0${stat.ino}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}`;
      const cached = this.legacyImageCache.get(resolved);
      if (!includeBytes && cached?.signature === signature) {
        return { ref: cached.ref, pathHash, reason: "legacy_image_reference_only", bytes: null };
      }
      const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      let bytes: Buffer;
      try {
        const opened = fs.fstatSync(descriptor);
        // A directory component may be exchanged for a symlink between
        // realpath/stat and open. O_NOFOLLOW protects only the final component.
        if (opened.dev !== stat.dev || opened.ino !== stat.ino) {
          return { ref: null, pathHash, reason: "legacy_image_outside_tool_media", bytes: null };
        }
        if (!opened.isFile() || opened.size <= 0 || opened.size > MAX_LEGACY_IMAGE_BYTES) {
          return { ref: null, pathHash, reason: "legacy_image_unavailable", bytes: null };
        }
        bytes = fs.readFileSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      if (!bytes.length || bytes.length > MAX_LEGACY_IMAGE_BYTES) {
        this.legacyImageCache.delete(resolved);
        return { ref: null, pathHash, reason: "legacy_image_unavailable", bytes: null };
      }
      const mimeType = detectImageMime(bytes);
      if (!mimeType) {
        this.legacyImageCache.delete(resolved);
        return { ref: null, pathHash, reason: "legacy_image_invalid", bytes: null };
      }
      const contentHash = crypto.createHash("sha256").update(bytes).digest("hex");
      const assetId = `legacy-${pathHash}-${contentHash}`;
      const ref = { assetId, mimeType, sizeBytes: bytes.length };
      this.legacyImageCache.set(resolved, { signature, ref });
      return { ref, pathHash, reason: "legacy_image_reference_only", bytes: includeBytes ? bytes : null };
    } catch {
      this.legacyImageCache.delete(resolved);
      return { ref: null, pathHash, reason: "legacy_image_expired", bytes: null };
    }
  }

  private legacyEvents(calls: LegacyCall[], assetPaths: Map<string, string>): ComputerUseHistoryEvent[] {
    const events: ComputerUseHistoryEvent[] = [];
    const promptIds = new Set<string>();
    const reasoningIds = new Set<string>();
    for (const call of calls) {
      let promptId: string | null = null;
      if (call.prompt) {
        promptId = stableId(call.source === "session" ? "s" : "t", [call.sessionId, "prompt", call.prompt.key]);
        if (!promptIds.has(promptId)) {
          promptIds.add(promptId);
          events.push(legacyEvent(
            call.source, promptId, "prompt", call.prompt.timestamp, call.prompt.orderIndex, call.sessionId,
            "User prompt", preview(call.prompt.text), "legacy_prompt_context_not_guaranteed",
            { turnId: call.prompt.turnId, origin: call.source },
            null, { text: call.prompt.text },
          ));
        }
      }
      const reasoningEvent = legacyReasoningEvent(call, promptId);
      const reasoningId = reasoningEvent?.id ?? null;
      if (reasoningEvent && !reasoningIds.has(reasoningEvent.id)) {
        reasoningIds.add(reasoningEvent.id);
        events.push(reasoningEvent);
      }
      const sourceCode = call.source === "session" ? "s" : "t";
      const callId = stableId(sourceCode, [call.sessionId, "tool_call", call.key]);
      const renderedResult = call.error
        ? { error: call.error, content: withoutImagePaths(call.result) }
        : { content: withoutImagePaths(call.result) };
      const reason = call.resultMissing
        ? "legacy_tool_result_missing"
        : call.source === "session" ? "legacy_tool_result_may_be_truncated" : "transcript_tool_result_is_sanitized";
      const firstText = call.evidence.find((item): item is Extract<LegacyEvidence, { kind: "ui_text" }> => item.kind === "ui_text");
      const evidenceIds = call.evidence.map((item, index) => (
        stableId(sourceCode, [call.sessionId, item.kind, call.key, index])
      ));
      events.push(legacyEvent(
        call.source, callId, "tool_call", call.timestamp, call.orderIndex, call.sessionId,
        call.name, firstText ? preview(firstText.text) : `${call.name} (legacy)`,
        reason,
        {
          toolName: call.name, callId: call.callId, turnId: call.turnId, origin: call.source,
          status: call.error ? "error" : "unknown", evidenceIds, reasoningId,
          correlation: call.callId ? "call_id" : "unverified_without_call_id",
        },
        promptId, { args: call.args, result: renderedResult },
      ));
      let textNumber = 0;
      let imageNumber = 0;
      for (const [index, item] of call.evidence.entries()) {
        const orderIndex = call.orderIndex + 1 + index;
        if (item.kind === "ui_text") {
          textNumber += 1;
          events.push(legacyEvent(
            call.source, evidenceIds[index], "ui_text", call.timestamp, orderIndex, call.sessionId,
            `${call.name} output ${textNumber}`, preview(item.text),
            call.source === "session" ? "legacy_ui_text_may_be_truncated" : "transcript_ui_text_is_sanitized",
            { toolName: call.name, callId: call.callId, turnId: call.turnId, blockIndex: item.blockIndex },
            callId, { text: item.text },
          ));
          continue;
        }
        imageNumber += 1;
        const image = this.legacyImage(item.imagePath);
        if (image.pathHash && item.imagePath) assetPaths.set(image.pathHash, item.imagePath);
        events.push(legacyEvent(
          call.source, evidenceIds[index], "screenshot", call.timestamp, orderIndex, call.sessionId,
          `${call.name} screenshot ${imageNumber}`,
          image.ref ? `${image.ref.mimeType}, ${image.ref.sizeBytes} bytes` : "Legacy screenshot unavailable",
          image.reason,
          { toolName: call.name, callId: call.callId, turnId: call.turnId, blockIndex: item.blockIndex },
          callId, { screenshot: image.ref },
        ));
      }
    }
    return events;
  }

  private collect(): { events: ComputerUseHistoryEvent[]; assetPaths: Map<string, string> } {
    const captured = this.store.readEvents();
    const recordedByCallId = new Map<string, ComputerUseHistoryEvent[]>();
    for (const event of captured) {
      if (event.kind !== "tool_call" || !event.sessionId) continue;
      const callId = comparableCallId(event.metadata.callId);
      if (!callId) continue;
      const identity = `${event.sessionId}\0${callId}`;
      const group = recordedByCallId.get(identity) ?? [];
      group.push(event);
      recordedByCallId.set(identity, group);
    }
    const assetPaths = new Map<string, string>();
    const regularCalls: LegacyCall[] = [];
    const recoveries: Array<{ call: LegacyCall; recorder: ComputerUseHistoryEvent }> = [];
    const reasoningBackfills: Array<{ call: LegacyCall; recorder: ComputerUseHistoryEvent }> = [];
    for (const call of preferredLegacyCalls([
      ...callsFromSessions(this.sessions),
      ...callsFromTranscripts(this.transcriptsRoot),
    ])) {
      const recorded = recordedByCallId.get(legacyCallIdentity(call) ?? "");
      if (!recorded) {
        regularCalls.push(call);
        continue;
      }
      if (call.reasoning && !captured.some((event) => event.kind === "reasoning"
        && event.sessionId === call.sessionId
        && event.text === call.reasoning?.text
        && (event.metadata.turnId ?? null) === (call.turnId ?? call.reasoning.turnId ?? null))) {
        reasoningBackfills.push({ call, recorder: [...recorded].sort(newerFirst)[0]! });
      }
      // A completed recorder already contains the raw result. An unfinished
      // recorder may still have result evidence in the older session sources.
      if (recorded.every(recorderNeedsRecovery) && hasLegacyResultEvidence(call)) {
        const recorder = [...recorded].sort(newerFirst)[0];
        recoveries.push({ call, recorder });
      }
    }
    const projected = [...captured, ...this.legacyEvents(regularCalls, assetPaths)];
    const backfilledReasoningIds = new Set<string>();
    for (const { call, recorder } of reasoningBackfills) {
      const reasoning = legacyReasoningEvent(call, recorder.parentId);
      if (!reasoning || backfilledReasoningIds.has(reasoning.id)) continue;
      backfilledReasoningIds.add(reasoning.id);
      projected.push({
        ...reasoning,
        metadata: {
          ...reasoning.metadata,
          recoverySource: call.source,
          recoveredForEventId: recorder.id,
          sameExecution: true,
        },
      });
    }
    for (const { call, recorder } of recoveries) {
      const legacy = this.legacyEvents([call], assetPaths);
      const legacyCall = legacy.find((event) => event.kind === "tool_call");
      if (!legacyCall) continue;
      const recoveredEvidence = legacy.filter((event) => event.parentId === legacyCall.id)
        .map((event, index) => ({
          ...event,
          timestamp: new Date(Math.max(Date.parse(recorder.timestamp), Date.parse(event.timestamp))).toISOString(),
          orderKey: recoveryOrderKey(recorder, event.timestamp, index, event.id),
          title: `Recovered ${event.title}`,
          parentId: recorder.id,
          metadata: {
            ...event.metadata,
            turnId: recorder.metadata.turnId ?? event.metadata.turnId ?? null,
            recoverySource: call.source,
            recoveredForEventId: recorder.id,
            sameExecution: true,
          },
        }));
      const recorderIndex = projected.findIndex((event) => event.id === recorder.id);
      if (recorderIndex < 0) continue;
      projected[recorderIndex] = {
        ...recorder,
        summary: `${call.name}: evidence recovered from ${call.source} for this incomplete recording`,
        missingReason: "recorder_result_recovered_from_legacy",
        metadata: {
          ...recorder.metadata,
          status: recorder.metadata.status === "pending" ? "unknown" : recorder.metadata.status,
          legacyRecovery: {
            source: call.source,
            sameExecution: true,
            evidenceIds: recoveredEvidence.map((event) => event.id),
            originalStatus: recorder.metadata.status ?? null,
            originalMissingReason: recorder.missingReason,
          },
        },
        result: call.result != null || call.error != null ? legacyCall.result : recorder.result,
      };
      projected.push(...recoveredEvidence);
    }
    return { events: projected, assetPaths };
  }

  list(query: ComputerUseHistoryQuery = {}): ComputerUseHistoryPage {
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ComputerUseHistoryError(400, "invalid_limit");
    const from = validatedBound(query.from, "from");
    const to = validatedBound(query.to, "to");
    if (from && to && from > to) throw new ComputerUseHistoryError(400, "invalid_time_range");
    if (query.kind && !["prompt", "reasoning", "tool_call", "ui_text", "screenshot"].includes(query.kind)) {
      throw new ComputerUseHistoryError(400, "invalid_kind");
    }
    const cursor = cursorTuple(query.cursor);
    const rows = this.collect().events
      .filter((event) => (!from || event.timestamp >= from) && (!to || event.timestamp <= to))
      .filter((event) => !query.kind || event.kind === query.kind)
      .filter((event) => !query.sessionId || event.sessionId === query.sessionId)
      .filter((event) => !query.turnId || event.metadata.turnId === query.turnId)
      .filter((event) => !cursor || event.orderKey < cursor[0] || (event.orderKey === cursor[0] && event.id < cursor[1]))
      .sort(newerFirst);
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit && page.length
      ? Buffer.from(JSON.stringify([page.at(-1)!.orderKey, page.at(-1)!.id])).toString("base64url")
      : null;
    return { events: page.map(summaryFromEvent), nextCursor };
  }

  get(id: string): ComputerUseHistoryEvent | null {
    const recorded = this.store.getEvent(id);
    if (recorded && !recorderNeedsRecovery(recorded)) return recorded;
    return this.collect().events.find((event) => event.id === id) ?? recorded ?? null;
  }

  readAsset(assetId: string): { mimeType: string; dataBase64: string } {
    if (!assetId.startsWith("legacy-")) {
      try { return this.store.readAsset(assetId); }
      catch (error) {
        if (error instanceof ComputerUseHistoryError && error.status === 404
          && this.store.readEvents().some((event) => event.screenshot?.assetId === assetId)) {
          throw new ComputerUseHistoryError(410, "asset_expired");
        }
        throw error;
      }
    }
    const match = /^legacy-([a-f0-9]{64})-([a-f0-9]{64})$/.exec(assetId);
    if (!match) throw new ComputerUseHistoryError(404, "asset_not_found");
    const { assetPaths } = this.collect();
    const assetPath = assetPaths.get(match[1]);
    if (!assetPath) throw new ComputerUseHistoryError(404, "asset_not_found");
    // Re-read and rehash the actual bytes for serving. The stat cache only
    // speeds list/detail projections and can never authorize a changed image.
    const checked = this.legacyImage(assetPath, true);
    if (!checked.ref || !checked.bytes || checked.ref.assetId !== assetId) {
      throw new ComputerUseHistoryError(410, checked.reason === "legacy_image_reference_only" ? "legacy_image_changed" : checked.reason);
    }
    return { mimeType: checked.ref.mimeType, dataBase64: checked.bytes.toString("base64") };
  }
}
