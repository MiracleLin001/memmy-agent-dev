import path from "node:path";
import { getDataDir } from "../../config/paths.js";
import type { RequestContext } from "../../core/agent-runtime/tools/context.js";
import {
  ComputerUseHistoryStore,
  isComputerUseHistorySupported,
  type ComputerUseCallHandle,
  type ComputerUseCallOutcome,
  type ComputerUseRecordContext,
} from "./history-store.js";

export type ComputerUseRecorderHandle = ComputerUseCallHandle & { store: ComputerUseHistoryStore };

const stores = new Map<string, ComputerUseHistoryStore>();

export function defaultComputerUseHistoryStore(): ComputerUseHistoryStore {
  const root = path.join(getDataDir(), "computer-use-history");
  let store = stores.get(root);
  if (!store) {
    store = new ComputerUseHistoryStore(root);
    stores.set(root, store);
  }
  return store;
}

export function computerUseRecordContext(
  explicit: ComputerUseRecordContext | null | undefined,
  request: RequestContext | null | undefined,
): ComputerUseRecordContext {
  const metadata = request?.metadata ?? {};
  const context = explicit ? { ...explicit } : {
    sessionId: request?.sessionKey ?? null,
    turnId: typeof metadata.turn_id === "string" ? metadata.turn_id : null,
    messageId: request?.messageId ?? null,
    channel: request?.channel ?? null,
    chatId: request?.chatId ?? null,
    promptText: null,
    promptTimestamp: null,
  } satisfies ComputerUseRecordContext;
  const text = (key: string): string | null => typeof metadata[key] === "string" && metadata[key].trim()
    ? metadata[key]
    : null;
  const iteration = typeof metadata.computerUseReasoningIteration === "number"
    && Number.isSafeInteger(metadata.computerUseReasoningIteration)
    ? metadata.computerUseReasoningIteration
    : null;
  return {
    ...context,
    ...(text("computerUseReasoning") ? { reasoning: text("computerUseReasoning") } : {}),
    ...(text("computerUseReasoningSummary") ? { reasoningSummary: text("computerUseReasoningSummary") } : {}),
    ...(text("computerUseThinkingBefore") ? { thinkingBefore: text("computerUseThinkingBefore") } : {}),
    ...(iteration !== null ? { reasoningIteration: iteration } : {}),
  };
}

function warnRecordingFailure(error: unknown): void {
  // Recording is observational. A disk error must not repeat, block or change
  // an application action that has already been dispatched.
  console.warn("[computer-use-history] local recording failed:", error instanceof Error ? error.message : String(error));
}

export function startComputerUseRecording(input: {
  server: string;
  toolName: string;
  args: Record<string, unknown>;
  callId?: string | null;
  managed?: boolean;
  attemptIndex?: number;
  context?: ComputerUseRecordContext | null;
}): ComputerUseRecorderHandle | null {
  if (!isComputerUseHistorySupported()) return null;
  try {
    const store = defaultComputerUseHistoryStore();
    return { ...store.startToolCall(input), store };
  } catch (error) {
    warnRecordingFailure(error);
    return null;
  }
}

export function finishComputerUseRecording(
  handle: ComputerUseRecorderHandle | null,
  rawResult: unknown,
  outcome: ComputerUseCallOutcome,
): void {
  if (!handle) return;
  try {
    handle.store.finishToolCall(handle, rawResult, outcome);
  } catch (error) {
    warnRecordingFailure(error);
  }
}
