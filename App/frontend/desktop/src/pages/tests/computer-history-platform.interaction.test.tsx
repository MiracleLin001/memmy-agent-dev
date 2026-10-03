// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CuHistoryEvent, CuHistoryEventDetail, MemmyAgentClient } from "../../api/memmy-agent-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { MemoryPage, type MemorySubPageId } from "../memory-page.js";
import { HISTORY_PERMISSION_SETUP_KEY } from "../memory/computer-history-permission-state.js";

const mocks = vi.hoisted(() => ({ historyPage: vi.fn(), dispatch: vi.fn(), track: vi.fn(), client: null as MemmyAgentClient | null }));
vi.mock("../../app/providers.js", () => ({ useApiClients: () => ({ clients: mocks.client ? { memmyAgent: mocks.client } : null }) }));
vi.mock("../../state/app-state.js", () => ({ useAppState: () => ({ state: null, dispatch: mocks.dispatch }) }));
vi.mock("../../analytics/use-analytics.js", () => ({ useAnalytics: () => ({ track: mocks.track, ready: false }) }));
vi.mock("../memory/overview-sub-page.js", () => ({ OverviewSubPage: () => "Overview content" }));
vi.mock("../memory/computer-history-sub-page.js", () => ({
  // If mounted, the real page starts polling and can resume permission setup.
  ComputerHistorySubPage: () => { mocks.historyPage(); return "History content"; },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.client = null;
  Object.defineProperty(window, "localStorage", { configurable: true, value: createMemoryStorage() });
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: createMemoryStorage() });
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/memory");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete window.memmy;
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});
function platform(value: string | undefined): void {
  Object.defineProperty(window, "memmy", { configurable: true, value: value ? { platform: value } : undefined });
}
function render(initialSubPage?: MemorySubPageId): void {
  act(() => root.render(<I18nProvider language="en-US"><MemoryPage initialSubPage={initialSubPage}/></I18nProvider>));
}

describe("Computer History platform availability", () => {
  it.each(["win32", "linux", undefined])("refuses the macOS human recording page on %s", (hostPlatform) => {
    platform(hostPlatform);
    render("computer-history");
    expect(host.querySelector(".memory-panel__title")).toBeNull();
    expect(host.textContent).toContain("Overview content");
    expect(mocks.historyPage).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("memmy.memorySubPage")).toBe("overview");
  });

  it.each(["saved page", "direct URL", "pending permission setup"])("ignores Windows human history %s without mounting permission/polling effects", (entry) => {
    platform("win32");
    if (entry === "saved page") window.sessionStorage.setItem("memmy.memorySubPage", "computer-history");
    if (entry === "direct URL") window.history.replaceState(null, "", "/memory?memoryPage=computer-history");
    if (entry === "pending permission setup") window.localStorage.setItem(HISTORY_PERMISSION_SETUP_KEY, "start");
    render();
    expect(host.querySelector(".memory-panel__title")).toBeNull();
    expect(host.textContent).toContain("Overview content");
    expect(mocks.historyPage).not.toHaveBeenCalled();
  });

  it.each(["explicit page", "saved page", "direct URL"])("opens the Windows read-only Agent history via %s", (entry) => {
    platform("win32");
    if (entry === "saved page") window.sessionStorage.setItem("memmy.memorySubPage", "agent-cu-history");
    if (entry === "direct URL") {
      window.sessionStorage.setItem("memmy.memorySubPage", "overview");
      window.history.replaceState(null, "", "/memory?memoryPage=agent-cu-history");
    }
    render(entry === "explicit page" ? "agent-cu-history" : undefined);
    expect(host.querySelector(".memory-panel__title")?.textContent).toBe("Agent Computer Use History");
    expect(host.textContent).toContain("Raw computer activity");
    expect(host.textContent).toContain("not deleted or replayed");
    expect(host.querySelector('[role="switch"]')).toBeNull();
    expect(host.textContent).not.toContain("Human activity summaries");
    expect(host.textContent).not.toContain("Clear history");
    expect(mocks.historyPage).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("memmy.memorySubPage")).toBe("agent-cu-history");
  });

  it.each(["linux", undefined])("hides Agent history on %s", (hostPlatform) => {
    platform(hostPlatform);
    render("agent-cu-history");
    expect(host.textContent).toContain("Overview content");
    expect(host.textContent).not.toContain("Agent Computer Use History");
    expect(window.sessionStorage.getItem("memmy.memorySubPage")).toBe("overview");
  });

  it("reads prompt, tool call, UI text and screenshot on Windows without invoking the human recorder", async () => {
    platform("win32");
    const row = (id: string, kind: CuHistoryEvent["kind"], title: string): CuHistoryEvent => ({
      id, kind, title, timestamp: "2026-09-30T06:00:00.000Z", orderKey: id,
      summary: `${title} summary`, source: "recorder", sessionId: "win-session",
      completeness: "complete", missingReason: null, metadata: {}, parentId: null,
    });
    const events = [
      row("1", "prompt", "Open Notepad"),
      row("2", "tool_call", "computer.get_app_state"),
      row("3", "ui_text", "Notepad window"),
      row("4", "screenshot", "Notepad screenshot"),
    ];
    const details: Record<string, CuHistoryEventDetail> = {
      "1": { ...events[0]!, text: "Please open Notepad.", args: null, result: null, screenshot: null },
      "2": { ...events[1]!, text: null, args: { app: "Notepad" }, result: { opened: true }, screenshot: null },
      "3": { ...events[2]!, text: "Notepad is ready.", args: null, result: null, screenshot: null },
      "4": { ...events[3]!, text: null, args: null, result: null, screenshot: { assetId: "win-image", mimeType: "image/png", sizeBytes: 68 } },
    };
    const listCuHistoryEvents = vi.fn().mockResolvedValue({ events, nextCursor: null });
    const getCuHistoryEvent = vi.fn().mockImplementation(async (id: string) => details[id]);
    const getCuHistoryAsset = vi.fn().mockResolvedValue({ mimeType: "image/png", dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7K8l8AAAAASUVORK5CYII=" });
    const getComputerHistory = vi.fn();
    const startComputerHistoryObservation = vi.fn();
    const clearComputerHistories = vi.fn();
    mocks.client = { listCuHistoryEvents, getCuHistoryEvent, getCuHistoryAsset, getComputerHistory,
      startComputerHistoryObservation, clearComputerHistories } as unknown as MemmyAgentClient;

    render();
    const entry = [...host.querySelectorAll<HTMLButtonElement>("nav button")].find((button) => button.textContent === "Agent Computer Use History");
    expect(entry).toBeDefined();
    expect([...host.querySelectorAll("nav button")].some((button) => button.textContent === "Computer History")).toBe(false);
    await act(async () => entry!.click());
    expect(listCuHistoryEvents).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Complete stitched history");
    await act(async () => host.querySelector<HTMLButtonElement>(".ch-raw__toggle")!.click());
    expect(listCuHistoryEvents).toHaveBeenCalledTimes(2);
    expect(events.every((event) => host.textContent?.includes(event.title))).toBe(true);

    const select = async (title: string) => {
      const button = [...host.querySelectorAll<HTMLButtonElement>(".ch-raw__event")].find((item) => item.textContent?.includes(title));
      expect(button).toBeDefined();
      await act(async () => button!.click());
    };
    await select("Open Notepad");
    expect(host.querySelector(".ch-raw__detail")?.textContent).toContain("Please open Notepad.");
    await select("computer.get_app_state");
    expect(host.querySelector(".ch-raw__detail")?.textContent).toContain('"app": "Notepad"');
    await select("Notepad window");
    expect(host.querySelector(".ch-raw__detail")?.textContent).toContain("Notepad is ready.");
    await select("Notepad screenshot");
    expect(host.querySelector<HTMLImageElement>(".ch-raw__detail img")?.src).toContain("data:image/png;base64,");
    expect(getCuHistoryAsset).toHaveBeenCalledWith("win-image", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(getComputerHistory).not.toHaveBeenCalled();
    expect(startComputerHistoryObservation).not.toHaveBeenCalled();
    expect(clearComputerHistories).not.toHaveBeenCalled();
    expect(mocks.historyPage).not.toHaveBeenCalled();
  });

  it("keeps the macOS entry and mounts History when selected", () => {
    platform("darwin");
    render();
    expect(host.textContent).not.toContain("Agent Computer Use History");
    const entry = [...host.querySelectorAll("button")].find((button) => button.textContent === "Computer History");
    expect(entry).toBeDefined();
    expect(mocks.historyPage).not.toHaveBeenCalled();
    act(() => entry!.click());
    expect(host.textContent).toContain("History content");
    expect(mocks.historyPage).toHaveBeenCalled();
  });

  it("refuses the Windows-only Agent history route on macOS", () => {
    platform("darwin");
    render("agent-cu-history");
    expect(host.textContent).toContain("Overview content");
    expect(host.textContent).not.toContain("Agent Computer Use History");
  });

  it("restores macOS pending permission onboarding", () => {
    platform("darwin");
    window.localStorage.setItem(HISTORY_PERMISSION_SETUP_KEY, "resume");
    render();
    expect(host.textContent).toContain("History content");
    expect(mocks.historyPage).toHaveBeenCalled();
  });
});
