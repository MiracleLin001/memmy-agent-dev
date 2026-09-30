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
  if (explicit) return { ...explicit };
  return {
    sessionId: request?.sessionKey ?? null,
    turnId: typeof request?.metadata?.turn_id === "string" ? request.metadata.turn_id : null,
    messageId: request?.messageId ?? null,
    channel: request?.channel ?? null,
    chatId: request?.chatId ?? null,
    promptText: null,
    promptTimestamp: null,
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
