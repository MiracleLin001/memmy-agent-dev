// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemmyAgentClient, type CuHistoryEvent, type CuHistoryEventDetail } from "../../api/memmy-agent-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CuHistoryPanel } from "../memory/cu-history-panel.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const timestamp = "2026-09-29T08:15:30.000Z";
const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7K8l8AAAAASUVORK5CYII=";

function event(id: string, kind: CuHistoryEvent["kind"], title: string, overrides: Partial<CuHistoryEvent> = {}): CuHistoryEvent {
  return {
    id, kind, title, timestamp, orderKey: timestamp, summary: `${title} summary`, source: "session", sessionId: "session-1",
    completeness: "complete", missingReason: null, metadata: {}, parentId: null, ...overrides,
  };
}

function detail(row: CuHistoryEvent, overrides: Partial<CuHistoryEventDetail> = {}): CuHistoryEventDetail {
  return { ...row, text: null, args: null, result: null, screenshot: null, ...overrides };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function eventButton(container: HTMLElement, title: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>(".ch-raw__event")].find((item) => item.textContent?.includes(title));
  if (!button) throw new Error(`missing event button: ${title}`);
  return button;
}

describe("Computer Use history API to desktop viewer", () => {
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

  it("renders saved prompts, tools, long UI text and screenshot assets, then explains a missing legacy image", async () => {
    const longUiText = `${"Visible UI content. ".repeat(85)}END-OF-UI-TEXT`;
    const promptRow = event("prompt-1", "prompt", "Open Notes", { timestamp: "2026-09-29T08:15:30.000Z", orderKey: "000001", source: "recorder", metadata: { turnId: "turn-1" } });
    const toolRow = event("tool-1", "tool_call", "computer.get_app_state", { timestamp: "2026-09-29T08:15:31.000Z", orderKey: "000002", source: "recorder", parentId: "prompt-1", metadata: { turnId: "turn-1", status: "ok", screenshotCount: 1 } });
    const uiRow = event("ui-1", "ui_text", "Notes window text", { timestamp: "2026-09-29T08:15:31.000Z", orderKey: "000003", source: "recorder", parentId: "tool-1" });
    const imageRow = event("image-1", "screenshot", "Notes screenshot", { timestamp: "2026-09-29T08:15:31.000Z", orderKey: "000004", source: "recorder", parentId: "tool-1" });
    const missingRow = event("image-old", "screenshot", "Old screenshot", {
      timestamp: "2026-09-29T08:15:00.000Z", orderKey: "000000", source: "transcript", completeness: "partial",
      missingReason: "legacy_image_path_missing",
    });
    const rows = [imageRow, uiRow, toolRow, promptRow, missingRow];
    const details: Record<string, CuHistoryEventDetail> = {
      "prompt-1": detail(promptRow, { text: "Please open Notes and read its contents." }),
      "tool-1": detail(toolRow, { args: { app: "Notes" }, result: { state: "opened" } }),
      "ui-1": detail(uiRow, { text: longUiText }),
      "image-1": detail(imageRow, { screenshot: { assetId: "asset-1", mimeType: "image/png", sizeBytes: 68 } }),
      "image-old": detail(missingRow),
    };
    const calls: Array<{ path: string; query: string; authorization?: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
      calls.push({ path: url.pathname, query: url.search, authorization });
      if (url.pathname === "/webui/bootstrap") return json({ token: "test-token", ws_path: "/ws", expires_in: 3600, model_name: null });
      if (url.pathname === "/api/cu-history/events") {
        expect(url.searchParams.get("limit")).toBe("50");
        const kind = url.searchParams.get("kind");
        if (kind) return json({ events: rows.filter((row) => row.kind === kind), nextCursor: null });
        if (url.searchParams.get("turn_id") === "turn-1") return json({ events: rows.slice(0, 4), nextCursor: null });
        if (url.searchParams.get("cursor") === "older") return json({ events: [missingRow], nextCursor: null });
        return json({ events: rows.slice(0, 4), nextCursor: "older" });
      }
      if (url.pathname.startsWith("/api/cu-history/events/")) {
        return json(details[decodeURIComponent(url.pathname.split("/").at(-1) ?? "")]);
      }
      if (url.pathname === "/api/cu-history/assets/asset-1") return json({ mimeType: "image/png", dataBase64: imageBase64 });
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    const client = createMemmyAgentClient({ baseUrl: "http://127.0.0.1:18980", fetchFn: fetchMock as typeof fetch });

    await act(async () => root.render(<I18nProvider language="zh-CN"><CuHistoryPanel client={client} /></I18nProvider>));
    expect(calls).toHaveLength(0); // The separate history stream loads only when opened.
    await act(async () => container.querySelector<HTMLButtonElement>(".ch-raw__toggle")!.click());
    expect(container.textContent).toContain("Open Notes");
    expect(container.textContent).toContain("computer.get_app_state");
    expect(container.textContent).toContain("Notes window text");
    expect(container.textContent).toContain("Notes screenshot");

    await act(async () => eventButton(container, "Open Notes").click());
    expect(container.querySelector(".ch-raw__detail")?.textContent).toContain("Please open Notes and read its contents.");
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".ch-raw__view-session")][1].click());
    expect(calls.some((call) => call.path === "/api/cu-history/events" && call.query.includes("session_id=session-1") && call.query.includes("turn_id=turn-1"))).toBe(true);
    expect([...container.querySelectorAll<HTMLButtonElement>(".ch-raw__event")].map((item) => item.querySelector("strong")?.textContent)).toEqual([
      "Open Notes", "computer.get_app_state", "Notes window text", "Notes screenshot",
    ]);
    expect(container.textContent).toContain("本轮操作时间线");
    await act(async () => container.querySelector<HTMLButtonElement>(".ch-raw__timeline-actions button")!.click());
    expect(calls.some((call) => call.path === "/api/cu-history/events" && call.query.includes("session_id=session-1") && !call.query.includes("turn_id="))).toBe(true);
    expect(container.textContent).toContain("会话时间线");

    await act(async () => eventButton(container, "computer.get_app_state").click());
    expect(container.querySelector(".ch-raw__detail")?.textContent).toContain('"app": "Notes"');
    expect(container.querySelector(".ch-raw__detail")?.textContent).toContain('"state": "opened"');
    expect(container.querySelector(".ch-raw__detail")?.textContent).toContain("工具返回了 1 个截图块");

    await act(async () => eventButton(container, "Notes window text").click());
    expect(container.querySelector(".ch-raw__detail")?.textContent).not.toContain("END-OF-UI-TEXT");
    await act(async () => container.querySelector<HTMLButtonElement>(".ch-raw__content-block button")!.click());
    expect(container.querySelector(".ch-raw__detail")?.textContent).toContain("END-OF-UI-TEXT");

    await act(async () => eventButton(container, "Notes screenshot").click());
    const image = container.querySelector<HTMLImageElement>(".ch-raw__image-frame img");
    expect(image?.src).toBe(`data:image/png;base64,${imageBase64}`);
    expect(image?.alt).toContain("Notes screenshot");
    await act(async () => image!.dispatchEvent(new Event("error")));
    expect(container.querySelector(".ch-raw__detail")?.textContent).toContain("图片数据格式无效");
    expect(container.querySelector(".ch-raw__detail img")).toBeNull();
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".ch-raw__detail button")]
      .find((button) => button.textContent === "查看关联事件")!.click());
    expect(container.querySelector(".ch-raw__detail")?.textContent).toContain('"app": "Notes"');

    await act(async () => container.querySelector<HTMLButtonElement>(".ch-raw__more")!.click());
    await act(async () => eventButton(container, "Old screenshot").click());
    expect(container.querySelector(".ch-raw__detail")?.textContent).toContain("部分缺失");
    expect(container.querySelector(".ch-raw__detail")?.textContent).toContain("旧记录引用的截图已失效或不在可读取的位置");
    expect(container.querySelector(".ch-raw__detail img")).toBeNull();

    const kindSelect = container.querySelector<HTMLSelectElement>(".ch-raw__filters select")!;
    await act(async () => {
      kindSelect.value = "screenshot";
      kindSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".ch-raw__filter-actions button")][0].click());
    expect(calls.some((call) => call.path === "/api/cu-history/events" && call.query.includes("kind=screenshot"))).toBe(true);
    expect(container.querySelectorAll(".ch-raw__event")).toHaveLength(2);
    expect(calls.filter((call) => call.path.startsWith("/api/cu-history/")).every((call) => call.authorization === "Bearer test-token")).toBe(true);
  });

  it("reports no screenshot only when a live tool result was observed", async () => {
    const live = event("live-tool", "tool_call", "computer.click", {
      source: "recorder", orderKey: "000003", metadata: { status: "ok", resultObserved: true, screenshotCount: 0 },
    });
    const uncertain = event("uncertain-tool", "tool_call", "computer.get_app_state", {
      source: "recorder", orderKey: "000002", completeness: "partial", missingReason: "tool_result_unavailable",
      metadata: { status: "uncertain", resultObserved: false, screenshotCount: null },
    });
    const legacy = event("legacy-tool", "tool_call", "computer.press_key", {
      source: "session", orderKey: "000001", completeness: "partial", missingReason: "legacy_tool_result_may_be_truncated",
      metadata: { status: "unknown", screenshotCount: 0 },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/webui/bootstrap") return json({ token: "test-token", ws_path: "/ws", expires_in: 3600, model_name: null });
      if (url.pathname === "/api/cu-history/events") return json({ events: [live, uncertain, legacy], nextCursor: null });
      if (url.pathname === "/api/cu-history/events/live-tool") return json(detail(live, { args: { x: 12, y: 8 }, result: { clicked: true } }));
      if (url.pathname === "/api/cu-history/events/uncertain-tool") return json(detail(uncertain));
      if (url.pathname === "/api/cu-history/events/legacy-tool") return json(detail(legacy, { result: { content: "possibly truncated" } }));
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    const client = createMemmyAgentClient({ baseUrl: "http://127.0.0.1:18980", fetchFn: fetchMock as typeof fetch });
    await act(async () => root.render(<I18nProvider language="zh-CN"><CuHistoryPanel client={client} /></I18nProvider>));
    await act(async () => container.querySelector<HTMLButtonElement>(".ch-raw__toggle")!.click());
    await act(async () => eventButton(container, "computer.click").click());
    expect(container.querySelector(".ch-raw__detail")?.textContent).toContain("工具未返回截图");
    await act(async () => eventButton(container, "computer.get_app_state").click());
    expect(container.querySelector(".ch-raw__detail")?.textContent).not.toContain("工具未返回截图");
    expect(container.querySelector(".ch-raw__detail")?.textContent).toContain("没有保存工具结果");
    await act(async () => eventButton(container, "computer.press_key").click());
    expect(container.querySelector(".ch-raw__detail")?.textContent).not.toContain("工具未返回截图");
    expect(container.querySelector(".ch-raw__detail")?.textContent).toContain("旧会话的工具结果可能被截断");
  });
});
