// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemmyAgentClient, type CuHistoryEvent, type CuHistoryEventDetail } from "../../api/memmy-agent-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CuHistoryStitchedPanel } from "../memory/cu-history-stitched-panel.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function event(
  id: string,
  sessionId: string,
  kind: CuHistoryEvent["kind"],
  title: string,
  orderKey: string,
  overrides: Partial<CuHistoryEvent> = {},
): CuHistoryEvent {
  const seconds = String(Number(orderKey)).padStart(2, "0");
  return {
    id, sessionId, kind, title, timestamp: `2026-09-29T08:15:${seconds}Z`, orderKey,
    summary: `${title} summary`, source: "recorder", completeness: "complete", missingReason: null,
    metadata: {}, parentId: null, ...overrides,
  };
}

function detail(row: CuHistoryEvent, overrides: Partial<CuHistoryEventDetail> = {}): CuHistoryEventDetail {
  return { ...row, text: null, args: null, result: null, screenshot: null, ...overrides };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("stitched Agent Computer Use history", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("groups every paginated event by conversation and opens its complete timeline", async () => {
    const promptNotes = event("notes-prompt", "session-notes", "prompt", "Open Notes", "000001", {
      summary: "Open Notes and inspect the window", metadata: { turnId: "notes-turn" },
    });
    const reasoningNotes = event("notes-reasoning", "session-notes", "reasoning", "Agent reasoning summary", "000002", {
      summary: "先读取窗口状态，再决定下一步", metadata: { turnId: "notes-turn", reasoningIteration: 1 }, parentId: promptNotes.id,
    });
    const toolNotes = event("notes-tool", "session-notes", "tool_call", "computer.get_app_state", "000002", {
      summary: "Notes window is open", metadata: { turnId: "notes-turn", status: "ok", screenshotCount: 1 }, parentId: promptNotes.id,
    });
    const textNotes = event("notes-text", "session-notes", "ui_text", "get_app_state output 1", "000003", {
      summary: "Notes window text", metadata: { turnId: "notes-turn" }, parentId: toolNotes.id,
    });
    const screenshotNotes = event("notes-image", "session-notes", "screenshot", "get_app_state screenshot 1", "000004", {
      summary: "image/png, 68 bytes", metadata: { turnId: "notes-turn" }, parentId: toolNotes.id,
    });
    const promptPaint = event("paint-prompt", "session-paint", "prompt", "Open Paint", "000005", {
      summary: "Open Paint", metadata: { turnId: "paint-turn" },
    });
    const failedPaint = event("paint-tool", "session-paint", "tool_call", "computer.get_app_state", "000006", {
      summary: "appNotFound(\"Paint\")", completeness: "complete", metadata: { turnId: "paint-turn", status: "error" }, parentId: promptPaint.id,
    });
    const firstPage = [failedPaint, promptPaint, toolNotes, reasoningNotes, promptNotes];
    const secondPage = [screenshotNotes, textNotes];
    const details: Record<string, CuHistoryEventDetail> = {
      [promptNotes.id]: detail(promptNotes, { text: "Open Notes and inspect the window" }),
      [reasoningNotes.id]: detail(reasoningNotes, { text: "先读取窗口状态，再决定下一步" }),
      [toolNotes.id]: detail(toolNotes, { args: { app: "Notes" }, result: { content: "Notes window is open" } }),
      [textNotes.id]: detail(textNotes, { text: "Notes window text" }),
      [screenshotNotes.id]: detail(screenshotNotes, { screenshot: { assetId: "asset-1", mimeType: "image/png", sizeBytes: 68 } }),
      [promptPaint.id]: detail(promptPaint, { text: "Open Paint" }),
      [failedPaint.id]: detail(failedPaint, { result: { isError: true, content: [{ type: "text", text: "appNotFound(\"Paint\")" }] } }),
    };
    let listCalls = 0;
    const fetchMock = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/webui/bootstrap") return json({ token: "test-token", ws_path: "/ws", expires_in: 3600, model_name: null });
      if (url.pathname === "/api/cu-history/events") {
        listCalls += 1;
        if (url.searchParams.get("cursor") === "older") return json({ events: secondPage, nextCursor: null });
        return json({ events: firstPage, nextCursor: "older" });
      }
      if (url.pathname.startsWith("/api/cu-history/events/")) {
        return json(details[decodeURIComponent(url.pathname.split("/").at(-1) ?? "")]);
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    };
    const client = createMemmyAgentClient({ baseUrl: "http://127.0.0.1:18980", fetchFn: fetchMock as typeof fetch });

    await act(async () => root.render(<I18nProvider language="zh-CN"><CuHistoryStitchedPanel client={client} /></I18nProvider>));

    expect(listCalls).toBe(2);
    expect(container.textContent).toContain("完整拼接历史");
    expect(container.textContent).toContain("Open Notes and inspect the window");
    expect(container.textContent).toContain("Open Paint");
    expect(container.textContent).toContain("思路摘要");
    expect(container.textContent).toContain("完整时间线");

    const notesEntry = [...container.querySelectorAll<HTMLButtonElement>(".ch-stitched__entry")]
      .find((button) => button.textContent?.includes("Open Notes"));
    expect(notesEntry).toBeDefined();
    await act(async () => notesEntry!.click());
    expect(container.textContent).toContain("get_app_state screenshot 1");
    expect(container.textContent).toContain("Notes window is open");
    expect(container.textContent).toContain("先读取窗口状态，再决定下一步");
    expect(container.querySelector(".ch-stitched__entry--selected")?.textContent).toContain("Open Notes");
  });
});
