import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";
import { AgentHookContext } from "../../../src/core/agent-runtime/hook.js";
import { AgentProgressHook } from "../../../src/core/agent-runtime/progress-hook.js";
import { RequestContext } from "../../../src/core/agent-runtime/tools/context.js";
import { MCPToolWrapper } from "../../../src/core/agent-runtime/tools/mcp.js";
import { WebSocketChannel } from "../../../src/integrations/channels/websocket.js";
import {
  ComputerUseHistoryError,
  ComputerUseHistoryStore,
  isComputerUseHistorySupported,
} from "../../../src/tools/computer-use/history-store.js";
import { ComputerUseHistoryService } from "../../../src/tools/computer-use/history-service.js";
import { ManagedOcuSession, OCU_TOOLS } from "../../../src/tools/computer-use/managed-ocu-session.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const GIF_BASE64 = "R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
const originalDataDir = process.env.MEMMY_AGENT_DATA_DIR;
let dataRoot: string;

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-cu-history-"));
  process.env.MEMMY_AGENT_DATA_DIR = dataRoot;
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalDataDir == null) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = originalDataDir;
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

function historyStore(): ComputerUseHistoryStore {
  return new ComputerUseHistoryStore(path.join(dataRoot, "computer-use-history"));
}

function channel(): WebSocketChannel {
  const instance = new WebSocketChannel(
    { enabled: true, allowFrom: ["*"], host: "127.0.0.1", port: 0, path: "/", websocketRequiresToken: false },
    new MessageBus(),
    { workspacePath: dataRoot },
  );
  instance.apiTokens.set("cu-history-test", Date.now() / 1000 + 60);
  return instance;
}

async function get(instance: WebSocketChannel, route: string, method = "GET", authorized = true) {
  return instance.dispatchHttp({}, {
    path: route,
    method,
    headers: authorized ? { Authorization: "Bearer cu-history-test" } : {},
  });
}

function body(response: Awaited<ReturnType<typeof get>>) {
  return JSON.parse(String(response?.body));
}

describe("Agent Computer Use recording and HTTP history", () => {
  it.each(["darwin", "win32"] as const)("reads a durable ordered prompt, tool result, text and screenshot through authenticated routes after restart on %s", async (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const writer = historyStore();
    const call = writer.startToolCall({
      server: "open_computer_use", toolName: "get_app_state", callId: "call-1", args: { app: "Notes" },
      context: { sessionId: "websocket:chat-1", turnId: "turn-1", messageId: "message-1", promptText: "Inspect Notes" },
    });
    writer.finishToolCall(call, {
      content: [
        { type: "text", text: "Notes window is open" },
        { type: "image", mimeType: "image/png", data: PNG_BASE64 },
      ],
      isError: false,
      structuredContent: { visible: true },
    }, { status: "ok", dispatched: true, attemptCount: 1 });

    const restarted = new ComputerUseHistoryService({ store: historyStore() });
    const saved = restarted.list({ turnId: "turn-1" }).events.sort((a, b) => a.orderKey.localeCompare(b.orderKey));
    expect(saved.map((event) => event.kind)).toEqual(["prompt", "tool_call", "ui_text", "screenshot"]);
    expect(saved.every((event) => event.metadata.turnId === "turn-1")).toBe(true);
    const tool = restarted.get(call.id)!;
    expect(tool).toMatchObject({ completeness: "complete", metadata: {
      status: "ok", dispatched: true, textBlockCount: 1, screenshotCount: 1,
    } });
    expect(tool.result).toMatchObject({ content: [
      { type: "text", text: "Notes window is open" },
      { type: "image", mimeType: "image/png", assetId: expect.any(String) },
    ] });
    expect(JSON.stringify(tool.result)).not.toContain(PNG_BASE64);

    const gateway = channel();
    expect((await get(gateway, "/api/cu-history/events?turn_id=turn-1", "GET", false))?.status).toBe(401);
    const first = await get(gateway, "/api/cu-history/events?limit=2&turn_id=turn-1");
    expect(first?.status).toBe(200);
    expect(first?.headers["cache-control"]).toBe("no-store");
    expect(body(first).events).toHaveLength(2);
    expect(body(first).nextCursor).toEqual(expect.any(String));
    const second = await get(gateway, `/api/cu-history/events?limit=2&turn_id=turn-1&cursor=${encodeURIComponent(body(first).nextCursor)}`);
    expect(second?.status).toBe(200);
    expect(body(second).events).toHaveLength(2);
    expect(body(second).nextCursor).toBeNull();
    const detail = await get(gateway, `/api/cu-history/events/${call.id}`);
    expect(detail?.status).toBe(200);
    expect(detail?.headers["cache-control"]).toBe("no-store");
    expect(body(detail).metadata).toMatchObject({ textBlockCount: 1, screenshotCount: 1 });
    const screenshot = saved.find((event) => event.kind === "screenshot")!;
    const assetId = restarted.get(screenshot.id)!.screenshot!.assetId;
    const asset = await get(gateway, `/api/cu-history/assets/${assetId}`);
    expect(asset?.headers["cache-control"]).toBe("no-store");
    expect(body(asset)).toEqual({ mimeType: "image/png", dataBase64: PNG_BASE64 });
    expect(String(detail?.body)).not.toContain(dataRoot);

    fs.unlinkSync(path.join(writer.root, "assets", `${assetId}.png`));
    expect(body(await get(gateway, `/api/cu-history/assets/${assetId}`))).toEqual({ error: "asset_expired" });
    expect((await get(gateway, `/api/cu-history/assets/${assetId}`))?.status).toBe(410);
    expect((await get(gateway, `/api/cu-history/assets/${"a".repeat(64)}`))?.status).toBe(404);
  });

  it("validates method, platform and query before exposing history", async () => {
    expect(isComputerUseHistorySupported("darwin")).toBe(true);
    expect(isComputerUseHistorySupported("win32")).toBe(true);
    expect(isComputerUseHistorySupported("linux")).toBe(false);
    const gateway = channel();
    expect((await get(gateway, "/api/cu-history/events", "POST"))?.status).toBe(405);
    for (const query of ["limit=101", "limit=1&limit=2", "kind=other", "from=not-a-date", "cursor=bad"]) {
      expect((await get(gateway, `/api/cu-history/events?${query}`))?.status, query).toBe(400);
    }
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    expect((await get(gateway, "/api/cu-history/events", "GET", false))?.status).toBe(401);
    expect((await get(gateway, "/api/cu-history/events"))?.status).toBe(400);
  });

  it("skips damaged event files without breaking a strict history page", async () => {
    const writer = historyStore();
    const call = writer.startToolCall({
      server: "open_computer_use", toolName: "list_apps", args: {},
      context: { sessionId: "websocket:valid", turnId: "valid-turn", promptText: "List apps" },
    });
    const valid = writer.getEvent(call.id)!;
    const invalidId = `${valid.timestamp.slice(0, 10)}-00000000-0000-4000-8000-000000000001`;
    fs.writeFileSync(path.join(writer.root, "events", valid.timestamp.slice(0, 10), `${invalidId}.json`),
      JSON.stringify({ ...valid, id: invalidId, metadata: null, orderKey: "broken" }));
    expect(writer.getEvent(invalidId)).toBeNull();
    const response = await get(channel(), "/api/cu-history/events");
    expect(response?.status).toBe(200);
    expect(body(response).events.map((event: { id: string }) => event.id)).not.toContain(invalidId);
    expect(body(response).events).toHaveLength(2);
  });

  it("uses a canonical inbound prompt time and falls back for expanded years", () => {
    const writer = historyStore();
    const normal = writer.recordPrompt({
      sessionId: "websocket:time", messageId: "message-1", promptText: "Inspect",
      promptTimestamp: "2026-09-29T23:59:59.000Z",
    });
    expect(writer.getEvent(normal!)?.timestamp).toBe("2026-09-29T23:59:59.000Z");
    expect(writer.getEvent(normal!)?.metadata.timestampSource).toBe("message");
    const invalid = writer.recordPrompt({
      sessionId: "websocket:time", messageId: "message-2", promptText: "Inspect again",
      promptTimestamp: "+010000-09-29T23:59:59.000Z",
    });
    expect(invalid).not.toBeNull();
    expect(writer.getEvent(invalid!)?.metadata.timestampSource).toBe("capture");
  });

  it("records one reasoning summary per tool iteration and links every tool call", () => {
    const writer = historyStore();
    const context = {
      sessionId: "websocket:reasoning", turnId: "reasoning-turn", messageId: "reasoning-message",
      promptText: "Inspect the current window", reasoning: "先读取当前窗口，再根据界面状态决定下一步。",
      reasoningSummary: "先读取当前窗口，再根据界面状态决定下一步。",
      thinkingBefore: "先读取当前窗口，再根据界面状态决定下一步。", reasoningIteration: 3,
    };
    const first = writer.startToolCall({ server: "open_computer_use", toolName: "get_app_state", callId: "reasoning-call-1", args: {}, context });
    const second = writer.startToolCall({ server: "open_computer_use", toolName: "list_apps", callId: "reasoning-call-2", args: {}, context });
    const rows = writer.readEvents().sort((left, right) => left.orderKey.localeCompare(right.orderKey));
    expect(rows.map((row) => row.kind)).toEqual(["prompt", "reasoning", "tool_call", "tool_call"]);
    const reasoning = rows.find((row) => row.kind === "reasoning")!;
    expect(reasoning).toMatchObject({ sessionId: "websocket:reasoning", parentId: rows[0]?.id, text: context.reasoning });
    expect(reasoning.metadata).toMatchObject({ turnId: "reasoning-turn", reasoningIteration: 3 });
    expect(first.id).not.toBe(second.id);
    expect(writer.getEvent(first.id)?.metadata.reasoningId).toBe(reasoning.id);
    expect(writer.getEvent(second.id)?.metadata.reasoningId).toBe(reasoning.id);
    expect(new ComputerUseHistoryService({ store: historyStore() }).list({ kind: "reasoning", turnId: "reasoning-turn" }).events)
      .toEqual([expect.objectContaining({ id: reasoning.id, kind: "reasoning" })]);
  });

  it("bridges Agent reasoning emitted before a tool into the CU recorder", async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Window is visible" }] });
    const wrapper = new MCPToolWrapper({ callTool }, "open_computer_use", {
      name: "get_app_state", description: "Read app", inputSchema: { type: "object", properties: {} },
    });
    const hook = new AgentProgressHook(null, null, null, {
      channel: "websocket",
      chatId: "reasoning-chat",
      sessionKey: "websocket:reasoning-chat",
      setToolContext: (channel, chatId, messageId, metadata, sessionKey) => wrapper.setContext(new RequestContext({
        channel, chatId, messageId, metadata, sessionKey,
      })),
    });
    await hook.beforeIteration(new AgentHookContext({ iteration: 2 }));
    await hook.emitReasoning("先读取窗口状态，再决定下一步。");
    await hook.beforeExecuteTools(new AgentHookContext({
      iteration: 2,
      response: { content: "", reasoningContent: null, thinkingBlocks: null },
      toolCalls: [{ name: "mcp_open_computer_use_get_app_state" }],
    }));
    await wrapper.execute({}, { callId: "reasoning-bridge", computerUseHistory: {
      sessionId: "websocket:reasoning-chat", turnId: "reasoning-bridge-turn", promptText: "Inspect the window",
    } });
    const rows = historyStore().readEvents().sort((left, right) => left.orderKey.localeCompare(right.orderKey));
    const reasoning = rows.find((row) => row.kind === "reasoning");
    expect(reasoning?.text).toContain("先读取窗口状态");
    expect(reasoning?.metadata.reasoningIteration).toBe(2);
    expect(rows.find((row) => row.kind === "tool_call")?.metadata.reasoningId).toBe(reasoning?.id);
  });

  it("accepts structured reasoning fields on the Agent response", async () => {
    const wrapper = new MCPToolWrapper(
      { callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Done" }] }) },
      "open_computer_use",
      { name: "get_app_state", description: "Read app", inputSchema: { type: "object", properties: {} } },
    );
    const hook = new AgentProgressHook(null, null, null, {
      channel: "websocket",
      chatId: "structured-reasoning-chat",
      sessionKey: "websocket:structured-reasoning-chat",
      setToolContext: (channel, chatId, messageId, metadata, sessionKey) => wrapper.setContext(new RequestContext({
        channel, chatId, messageId, metadata, sessionKey,
      })),
    });
    await hook.beforeIteration(new AgentHookContext({ iteration: 4 }));
    await hook.beforeExecuteTools(new AgentHookContext({
      iteration: 4,
      response: {
        content: "",
        reasoning: "先读取 reasoning 字段，再执行工具。",
        reasoningSummary: "先读取 reasoning 字段，再执行工具。",
        thinkingBefore: "先读取 reasoning 字段，再执行工具。",
      },
      toolCalls: [{ name: "mcp_open_computer_use_get_app_state" }],
    }));
    await wrapper.execute({}, {
      callId: "structured-reasoning-call",
      computerUseHistory: {
        sessionId: "websocket:structured-reasoning-chat",
        turnId: "structured-reasoning-turn",
        promptText: "Inspect the window",
      },
    });
    const rows = historyStore().readEvents().sort((left, right) => left.orderKey.localeCompare(right.orderKey));
    expect(rows.find((row) => row.kind === "reasoning")?.text).toBe("先读取 reasoning 字段，再执行工具。");
  });

  it("cleans an unfinished atomic event file when disk writing fails", () => {
    const writer = historyStore();
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("disk full"); });
    try {
      expect(() => writer.recordPrompt({ promptText: "Inspect", messageId: "disk-error" })).toThrow("disk full");
    } finally { write.mockRestore(); }
    const dayRoot = path.join(writer.root, "events", new Date().toISOString().slice(0, 10));
    expect(fs.readdirSync(dayRoot)).toEqual([]);
  });

  it("distinguishes a returned result without images from an unavailable image and an unknown outcome", () => {
    const writer = historyStore();
    const context = { sessionId: "websocket:count", turnId: "count-turn", promptText: "Inspect" };
    const textOnly = writer.startToolCall({ server: "open_computer_use", toolName: "list_apps", args: {}, context });
    writer.finishToolCall(textOnly, { content: [{ type: "text", text: "No screenshots in this result" }], isError: false },
      { status: "ok", dispatched: true });
    expect(writer.getEvent(textOnly.id)).toMatchObject({ completeness: "complete", metadata: {
      screenshotCount: 0, textBlockCount: 1, status: "ok",
    } });

    const invalidImage = writer.startToolCall({ server: "open_computer_use", toolName: "get_app_state", args: {}, context });
    writer.finishToolCall(invalidImage, { content: [
      { type: "image", mimeType: "image/png", data: PNG_BASE64 },
      { type: "image", mimeType: "image/png", data: "invalid" },
    ] }, { status: "ok", dispatched: true });
    expect(writer.getEvent(invalidImage.id)).toMatchObject({ completeness: "partial", missingReason: "invalid_or_unavailable_image", metadata: {
      screenshotCount: 2, textBlockCount: 0,
    } });
    expect(writer.readEvents().filter((event) => event.kind === "screenshot" && event.parentId === invalidImage.id)
      .sort((a, b) => a.orderKey.localeCompare(b.orderKey))
      .map((event) => event.screenshot !== null)).toEqual([true, false]);

    const unknown = writer.startToolCall({ server: "open_computer_use", toolName: "click", args: {}, context });
    writer.finishToolCall(unknown, null, { status: "uncertain", dispatched: true });
    expect(writer.getEvent(unknown.id)).toMatchObject({ completeness: "partial", missingReason: "tool_outcome_unknown", metadata: {
      status: "uncertain", resultObserved: false, screenshotCount: null, textBlockCount: null,
    } });
  });

  it("omits image data URIs and base64 image arrays while keeping long UI text", () => {
    const writer = historyStore();
    const imageBase64 = Buffer.concat([
      Buffer.from(PNG_BASE64, "base64"), Buffer.alloc(1024),
    ]).toString("base64");
    const imageDataUri = `data:image/png;base64,${imageBase64}`;
    const longText = "The Notes window contains ordinary readable text. ".repeat(40);
    const plainWords = "Hello world ".repeat(100);
    const call = writer.startToolCall({ server: "open_computer_use", toolName: "get_app_state", args: {} });
    writer.finishToolCall(call, {
      content: [
        { type: "text", text: longText },
        { type: "text", text: imageDataUri },
        { type: "text", text: `Before ${imageDataUri} after` },
      ],
      structuredContent: {
        image_url: { url: imageDataUri },
        screenshot: imageBase64,
        frames: [imageBase64],
        note: longText,
        plainWords,
        data: plainWords,
      },
    });

    const saved = writer.getEvent(call.id)!;
    expect(JSON.stringify(saved.result)).not.toContain(imageBase64);
    expect(saved.result).toMatchObject({ structuredContent: { note: longText, plainWords, data: plainWords } });
    const textEvents = writer.readEvents().filter((event) => event.kind === "ui_text" && event.parentId === call.id)
      .sort((left, right) => left.orderKey.localeCompare(right.orderKey));
    expect(textEvents.map((event) => event.text)).toEqual([
      longText,
      expect.stringContaining("[binary payload omitted:"),
      expect.stringMatching(/^Before \[binary payload omitted: \d+ characters\] after$/),
    ]);
    expect(textEvents[1].text).not.toContain(imageBase64);
    expect(textEvents[2].text).not.toContain(imageBase64);
  });

  it.each(["darwin", "win32"] as const)("records the raw OCU response before model image conversion and separates two retries on %s", async (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const raw = { content: [
      { type: "text", text: "First line" },
      { type: "image", mimeType: "image/png", data: PNG_BASE64 },
      { type: "text", text: "Last line" },
    ], isError: false };
    const callTool = vi.fn().mockResolvedValue(raw);
    const wrapper = new MCPToolWrapper({ callTool }, "open_computer_use", {
      name: "get_app_state", description: "Read app", inputSchema: { type: "object", properties: {} },
    });
    await wrapper.execute({ app: "Notes" }, { callId: "raw-1", computerUseHistory: {
      sessionId: "websocket:raw", turnId: "raw-turn", messageId: "raw-message", promptText: "Read Notes",
    } });
    const rows = historyStore().readEvents().sort((a, b) => a.orderKey.localeCompare(b.orderKey));
    expect(rows.map((row) => row.kind)).toEqual(["prompt", "tool_call", "ui_text", "screenshot", "ui_text"]);
    const call = rows.find((row) => row.kind === "tool_call")!;
    expect(call).toMatchObject({ sessionId: "websocket:raw", metadata: {
      textBlockCount: 2, screenshotCount: 1, status: "ok", callId: "raw-1",
    } });
    expect(call.result).toMatchObject({ content: [
      { type: "text", text: "First line" },
      { type: "image", assetId: expect.any(String) },
      { type: "text", text: "Last line" },
    ] });
    expect(rows.find((row) => row.kind === "screenshot")?.screenshot).toMatchObject({ mimeType: "image/png" });

    const transient = Object.assign(new Error("lost response"), { name: "ClosedResourceError" });
    callTool.mockReset().mockRejectedValueOnce(transient).mockResolvedValueOnce({ content: [{ type: "text", text: "recovered" }] });
    await wrapper.execute({}, { callId: "retry-1", computerUseHistory: {
      sessionId: "websocket:raw", turnId: "retry-turn", messageId: "retry-message", promptText: "Retry read",
    } });
    const attempts = historyStore().readEvents().filter((row) => row.kind === "tool_call" && row.metadata.callId === "retry-1")
      .sort((a, b) => a.orderKey.localeCompare(b.orderKey));
    expect(attempts.map((row) => [row.metadata.attemptIndex, row.metadata.status])).toEqual([
      [1, "uncertain"], [2, "ok"],
    ]);
    expect(attempts[1].metadata.screenshotCount).toBe(0);
  });

  it("records a Windows OCU error without classifying it as a macOS permission failure", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const result = { isError: true, content: [{ type: "text", text: "Accessibility permission is required." }] };
    const callTool = vi.fn().mockResolvedValue(result);
    const wrapper = new MCPToolWrapper({ callTool }, "open_computer_use", {
      name: "get_app_state", description: "Read app", inputSchema: { type: "object", properties: {} },
    });
    const stopTurn = vi.fn();
    await expect(wrapper.execute({ app: "Notes" }, { callId: "win-error", stopTurn,
      computerUseHistory: { sessionId: "websocket:win", turnId: "win-turn", promptText: "Inspect Notes" },
    })).resolves.toBe("Accessibility permission is required.");
    expect(callTool).toHaveBeenCalledOnce();
    expect(stopTurn).not.toHaveBeenCalled();
    const call = historyStore().readEvents().find((event) => event.kind === "tool_call")!;
    expect(call).toMatchObject({ completeness: "complete", metadata: {
      callId: "win-error", managed: false, status: "error", dispatched: true,
      error: null, textBlockCount: 1, screenshotCount: 0,
    } });
    expect(call.result).toMatchObject(result);
  });

  it("keeps a post-dispatch permission error and its MCP result when the guide cannot pause", async () => {
    const sessions: Array<{ session: any; close: ReturnType<typeof vi.fn> }> = [];
    const result = { isError: true, content: [{ type: "text", text: "Accessibility permission is required." }] };
    const owner = new ManagedOcuSession(async () => {
      const session = {
        listTools: vi.fn().mockResolvedValue({ tools: [...OCU_TOOLS].map((name) => ({ name, inputSchema: {} })) }),
        ping: vi.fn().mockResolvedValue({}), callTool: vi.fn().mockResolvedValue(result),
      };
      const connection = { session, close: vi.fn().mockResolvedValue(undefined) };
      sessions.push(connection);
      return connection;
    }, async () => ({ state: "granted" }), vi.fn(), async () => { throw new Error("could not pause"); });
    const wrapper = new MCPToolWrapper({}, "open_computer_use", {
      name: "click", description: "Click", inputSchema: { type: "object", properties: {} },
    }, 30, undefined, owner);
    wrapper.setContext(new RequestContext({ sessionKey: "websocket:managed", messageId: "managed-message" }));
    try {
      await wrapper.execute({}, { callId: "managed-call", computerUseHistory: {
        sessionId: "websocket:managed", turnId: "managed-turn", messageId: "managed-message", promptText: "Click Notes",
      } });
      expect(sessions.flatMap((item) => item.session.callTool.mock.calls)).toHaveLength(1);
      const call = historyStore().readEvents().find((row) => row.kind === "tool_call")!;
      expect(call.metadata).toMatchObject({ status: "error", dispatched: true, textBlockCount: 1, screenshotCount: 0 });
      expect(call.result).toMatchObject(result);
    } finally { await owner.close(); }
  });

  it("keeps two concurrent chats separate when they share an MCP wrapper", async () => {
    const completions = new Map<string, (value: unknown) => void>();
    const callTool = vi.fn((_name: string, args: { app: string }) => new Promise((resolve) => {
      completions.set(args.app, resolve);
    }));
    const wrapper = new MCPToolWrapper({ callTool }, "open_computer_use", {
      name: "get_app_state", description: "Read app", inputSchema: { type: "object", properties: {} },
    });
    wrapper.setContext(new RequestContext({ sessionKey: "websocket:A", messageId: "message-A" }));
    const a = wrapper.execute({ app: "A" }, { callId: "call-A", computerUseHistory: {
      sessionId: "websocket:A", turnId: "turn-A", messageId: "message-A", promptText: "Inspect A",
    } });
    wrapper.setContext(new RequestContext({ sessionKey: "websocket:B", messageId: "message-B" }));
    const b = wrapper.execute({ app: "B" }, { callId: "call-B", computerUseHistory: {
      sessionId: "websocket:B", turnId: "turn-B", messageId: "message-B", promptText: "Inspect B",
    } });
    await vi.waitFor(() => expect(completions.size).toBe(2));
    completions.get("B")!({ content: [{ type: "text", text: "B visible" }] });
    completions.get("A")!({ content: [{ type: "text", text: "A visible" }] });
    await Promise.all([a, b]);
    const calls = historyStore().readEvents().filter((event) => event.kind === "tool_call");
    expect(calls.map((event) => [event.metadata.callId, event.sessionId, event.metadata.turnId]).sort()).toEqual([
      ["call-A", "websocket:A", "turn-A"],
      ["call-B", "websocket:B", "turn-B"],
    ]);
  });
});

describe("partial legacy Computer Use evidence", () => {
  it("projects reasoning from legacy session messages and binds it to the tool", () => {
    const service = new ComputerUseHistoryService({
      store: historyStore(),
      sessions: { listSessionRecords: () => [{ key: "websocket:legacy-reasoning", messages: [
        { role: "user", content: "Inspect Notes", turn_id: "legacy-reasoning-turn" },
        {
          role: "assistant", turn_id: "legacy-reasoning-turn", reasoning_content: "先读取窗口，再决定下一步。",
          tool_calls: [{ id: "legacy-reasoning-call", function: { name: "mcp_open_computer_use_get_app_state", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "legacy-reasoning-call", content: [{ type: "text", text: "Notes is open" }] },
      ] }] },
    });

    const rows = service.list({ sessionId: "websocket:legacy-reasoning" }).events;
    const reasoning = rows.find((event) => event.kind === "reasoning");
    const tool = rows.find((event) => event.kind === "tool_call");
    expect(reasoning).toMatchObject({ source: "session", metadata: {
      turnId: "legacy-reasoning-turn", callId: "legacy-reasoning-call",
    } });
    expect(tool?.metadata.reasoningId).toBe(reasoning?.id);
    expect(service.get(reasoning!.id)?.text).toBe("先读取窗口，再决定下一步。");
  });

  it("backfills reasoning beside an already recorded tool call without duplicating the call", () => {
    const writer = historyStore();
    const recorded = writer.startToolCall({
      server: "open_computer_use", toolName: "get_app_state", callId: "backfill-call", args: {},
      context: {
        sessionId: "websocket:backfill-reasoning", turnId: "backfill-turn", promptText: "Inspect Notes",
      },
    });
    const service = new ComputerUseHistoryService({
      store: writer,
      sessions: { listSessionRecords: () => [{ key: "websocket:backfill-reasoning", messages: [
        { role: "user", content: "Inspect Notes", turn_id: "backfill-turn" },
        {
          role: "assistant", turn_id: "backfill-turn", reasoning_content: "从旧会话补回思路摘要。",
          tool_calls: [{ id: "backfill-call", function: { name: "mcp_open_computer_use_get_app_state", arguments: "{}" } }],
        },
      ] }] },
    });

    const rows = service.list({ sessionId: "websocket:backfill-reasoning" }).events;
    expect(rows.filter((event) => event.kind === "tool_call").map((event) => event.id)).toEqual([recorded.id]);
    const reasoning = rows.find((event) => event.kind === "reasoning");
    expect(reasoning).toMatchObject({ source: "session", metadata: {
      recoveredForEventId: recorded.id, sameExecution: true,
    }, parentId: writer.getEvent(recorded.id)?.parentId });
    expect(service.get(reasoning!.id)?.text).toBe("从旧会话补回思路摘要。");
  });

  it("projects reasoning deltas from a legacy WebUI transcript", () => {
    const webuiRoot = path.join(dataRoot, "webui");
    fs.mkdirSync(webuiRoot, { recursive: true });
    fs.writeFileSync(path.join(webuiRoot, "websocket_transcript-reasoning.jsonl"), [
      { event: "user", turn_id: "transcript-reasoning-turn", text: "Inspect", createdAt: "2026-09-30T00:00:00.000Z" },
      { event: "reasoning_delta", turn_id: "transcript-reasoning-turn", text: "先看窗口", createdAt: "2026-09-30T00:00:01.000Z" },
      { event: "reasoning_delta", turn_id: "transcript-reasoning-turn", text: "再执行工具。", createdAt: "2026-09-30T00:00:01.100Z" },
      { event: "message", turn_id: "transcript-reasoning-turn", createdAt: "2026-09-30T00:00:02.000Z", tool_events: [{
        name: "mcp_open_computer_use_get_app_state", call_id: "transcript-reasoning-call", result: "Visible",
      }] },
    ].map((row) => JSON.stringify(row)).join("\n"));
    const service = new ComputerUseHistoryService({ store: historyStore(), transcriptsRoot: webuiRoot });

    const rows = service.list({ sessionId: "websocket:transcript-reasoning" }).events;
    const reasoning = rows.find((event) => event.kind === "reasoning");
    const tool = rows.find((event) => event.kind === "tool_call");
    expect(service.get(reasoning!.id)?.text).toBe("先看窗口再执行工具。");
    expect(tool?.metadata.reasoningId).toBe(reasoning?.id);
  });

  it("attaches a legacy result to an unfinished recorder call without projecting a second execution", () => {
    const mediaRoot = path.join(dataRoot, "media", "tool-results");
    fs.mkdirSync(mediaRoot, { recursive: true });
    const imagePath = path.join(mediaRoot, "recovered.png");
    fs.writeFileSync(imagePath, Buffer.from(PNG_BASE64, "base64"));
    const writer = historyStore();
    const pending = writer.startToolCall({
      server: "open_computer_use", toolName: "get_app_state", callId: "same-call", args: {},
      context: { sessionId: "websocket:recover", turnId: "recover-turn", promptText: "Inspect Notes" },
    });
    const service = new ComputerUseHistoryService({
      store: writer, legacyMediaRoot: mediaRoot,
      sessions: { listSessionRecords: () => [{
        key: "websocket:recover", createdAt: "2026-09-30T00:00:00.000Z", messages: [
          { role: "user", content: "Inspect Notes", turn_id: "recover-turn" },
          { role: "assistant", turn_id: "recover-turn", tool_calls: [{
            id: "same-call", function: { name: "mcp_open_computer_use_get_app_state", arguments: "{}" },
          }] },
          { role: "tool", tool_call_id: "same-call", content: [
            { type: "text", text: "Notes is open" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_BASE64}` }, meta: { path: imagePath } },
          ] },
        ],
      }] },
    });

    const rows = service.list({ sessionId: "websocket:recover" }).events;
    expect(rows.filter((event) => event.kind === "tool_call").map((event) => event.id)).toEqual([pending.id]);
    const call = service.get(pending.id)!;
    expect(call).toMatchObject({ source: "recorder", completeness: "partial",
      missingReason: "recorder_result_recovered_from_legacy", metadata: {
      status: "unknown", legacyRecovery: {
        source: "session", sameExecution: true,
        originalStatus: "pending", originalMissingReason: "tool_result_pending",
      },
    } });
    expect(call.summary).toContain("evidence recovered from session for this incomplete recording");
    expect(call.result).toMatchObject({ content: [
      { type: "text", text: "Notes is open" },
      { type: "image_url", image_url: { url: "[image reference]" } },
    ] });
    expect(writer.getEvent(pending.id)?.result).toBeNull();
    const children = rows.filter((event) => event.parentId === pending.id);
    expect(children.map((event) => event.kind).sort()).toEqual(["screenshot", "ui_text"]);
    expect(children.every((event) => event.title.startsWith("Recovered ") && event.orderKey > call.orderKey)).toBe(true);
    expect(children.every((event) => event.metadata.recoveredForEventId === pending.id && event.metadata.sameExecution === true)).toBe(true);
    const screenshot = service.get(children.find((event) => event.kind === "screenshot")!.id)!.screenshot!;
    expect(service.readAsset(screenshot.assetId)).toEqual({ mimeType: "image/png", dataBase64: PNG_BASE64 });

    writer.finishToolCall(pending, null, { status: "timeout", dispatched: true });
    expect(service.get(pending.id)).toMatchObject({
      missingReason: "recorder_result_recovered_from_legacy", metadata: {
        status: "timeout", legacyRecovery: {
          originalStatus: "timeout", originalMissingReason: "tool_result_timeout",
        },
      },
    });
  });

  it("uses transcript evidence when the same session call has no saved tool result", () => {
    const webuiRoot = path.join(dataRoot, "webui");
    fs.mkdirSync(webuiRoot, { recursive: true });
    fs.writeFileSync(path.join(webuiRoot, "websocket_merge.jsonl"), [
      { event: "user", turn_id: "turn-merge", text: "Click", createdAt: "2026-09-30T00:00:00.000Z" },
      { event: "message", turn_id: "turn-merge", createdAt: "2026-09-30T00:00:02.000Z", tool_events: [{
        name: "mcp_open_computer_use_click", call_id: "shared-id", result: "Clicked the button",
      }] },
    ].map((row) => JSON.stringify(row)).join("\n"));
    const service = new ComputerUseHistoryService({
      store: historyStore(), transcriptsRoot: webuiRoot,
      sessions: { listSessionRecords: () => [{
        key: "websocket:merge", messages: [
          { role: "user", content: "Click", turn_id: "turn-merge" },
          { role: "assistant", turn_id: "turn-merge", tool_calls: [{
            id: "shared-id", function: { name: "mcp_open_computer_use_click", arguments: "{}" },
          }] },
        ],
      }] },
    });

    const calls = service.list({ kind: "tool_call", sessionId: "websocket:merge" }).events;
    expect(calls).toHaveLength(1);
    expect(calls[0].source).toBe("transcript");
    expect(service.get(calls[0].id)?.result).toEqual({ content: "Clicked the button" });
    expect(service.list({ kind: "ui_text", sessionId: "websocket:merge" }).events.map((event) => event.summary))
      .toEqual(["Clicked the button"]);
  });

  it("prefers a longer transcript UI result when both sources have one text block", () => {
    const webuiRoot = path.join(dataRoot, "webui");
    fs.mkdirSync(webuiRoot, { recursive: true });
    const fullText = "The application window is open and the requested button is visible.";
    fs.writeFileSync(path.join(webuiRoot, "websocket_quality.jsonl"), JSON.stringify({
      event: "message", createdAt: "2026-09-30T00:00:02.000Z", tool_events: [{
        name: "mcp_open_computer_use_get_app_state", call_id: "quality-id", result: fullText,
      }],
    }));
    const service = new ComputerUseHistoryService({
      store: historyStore(), transcriptsRoot: webuiRoot,
      sessions: { listSessionRecords: () => [{ key: "websocket:quality", messages: [
        { role: "assistant", tool_calls: [{
          id: "quality-id", function: { name: "mcp_open_computer_use_get_app_state" },
        }] },
        { role: "tool", tool_call_id: "quality-id", content: [{ type: "text", text: "The app is open" }] },
      ] }] },
    });

    const calls = service.list({ kind: "tool_call", sessionId: "websocket:quality" }).events;
    expect(calls).toHaveLength(1);
    expect(calls[0].source).toBe("transcript");
    expect(service.get(calls[0].id)?.result).toEqual({ content: fullText });
  });

  it("redacts an inline image URI in legacy result text while preserving prompt and surrounding words", () => {
    const longPrompt = "Inspect the current Notes window carefully. ".repeat(40);
    const resultText = `Before data:image/png;base64,${PNG_BASE64} after`;
    const service = new ComputerUseHistoryService({
      store: historyStore(), sessions: { listSessionRecords: () => [{
        key: "websocket:legacy-inline", messages: [
          { role: "user", content: longPrompt },
          { role: "assistant", tool_calls: [{
            id: "inline-call", function: { name: "mcp_open_computer_use_get_app_state" },
          }] },
          { role: "tool", tool_call_id: "inline-call", content: resultText },
        ],
      }] },
    });

    const prompt = service.list({ kind: "prompt", sessionId: "websocket:legacy-inline" }).events[0];
    expect(service.get(prompt.id)?.text).toBe(longPrompt);
    const call = service.list({ kind: "tool_call", sessionId: "websocket:legacy-inline" }).events[0];
    const result = service.get(call.id)!;
    expect(JSON.stringify(result.result)).not.toContain(PNG_BASE64);
    expect(result.result).toEqual({ content: expect.stringMatching(/^Before \[binary payload omitted: \d+ characters\] after$/) });
    const textEvent = service.list({ kind: "ui_text", sessionId: "websocket:legacy-inline" }).events[0];
    expect(service.get(textEvent.id)?.text).toMatch(/^Before \[binary payload omitted: \d+ characters\] after$/);
  });

  it.each(["darwin", "win32"] as const)("preserves text/image order and invalidates an old asset ID when its file changes on %s", (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const mediaRoot = path.join(dataRoot, "media", "tool-results");
    fs.mkdirSync(mediaRoot, { recursive: true });
    const imagePath = path.join(mediaRoot, "tool_legacy.png");
    fs.writeFileSync(imagePath, Buffer.from(PNG_BASE64, "base64"));
    const service = new ComputerUseHistoryService({
      store: historyStore(), legacyMediaRoot: mediaRoot,
      sessions: { listSessionRecords: () => [{
        key: "websocket:legacy", createdAt: "2026-09-30T00:00:00.000Z", messages: [
          { role: "user", content: "Inspect legacy Notes", turn_id: "legacy-turn", timestamp: "2026-09-30T00:00:00.000Z" },
          { role: "assistant", turn_id: "legacy-turn", timestamp: "2026-09-30T00:00:01.000Z", tool_calls: [{
            id: "legacy-call", function: { name: "mcp_open_computer_use_get_app_state", arguments: "{\"app\":\"Notes\"}" },
          }] },
          { role: "tool", tool_call_id: "legacy-call", content: [
            { type: "text", text: `Before [image: ${imagePath}] after` },
            { type: "text", text: "Second block" },
          ] },
        ],
      }] },
    });
    const rows = service.list({ turnId: "legacy-turn" }).events.sort((a, b) => a.orderKey.localeCompare(b.orderKey));
    expect(rows.map((row) => row.kind)).toEqual(["prompt", "tool_call", "ui_text", "screenshot", "ui_text", "ui_text"]);
    expect(rows.every((row) => row.completeness === "partial")).toBe(true);
    const screenshot = service.get(rows.find((row) => row.kind === "screenshot")!.id)!.screenshot!;
    expect(screenshot.assetId).toMatch(/^legacy-[a-f0-9]{64}-[a-f0-9]{64}$/);
    expect(service.readAsset(screenshot.assetId)).toEqual({ mimeType: "image/png", dataBase64: PNG_BASE64 });
    fs.writeFileSync(imagePath, Buffer.from(GIF_BASE64, "base64"));
    expect(() => service.readAsset(screenshot.assetId)).toThrowError(ComputerUseHistoryError);
    try { service.readAsset(screenshot.assetId); } catch (error) {
      expect(error).toMatchObject({ status: 410, code: "legacy_image_changed" });
    }
    fs.unlinkSync(imagePath);
    try { service.readAsset(screenshot.assetId); } catch (error) {
      expect(error).toMatchObject({ status: 410, code: "legacy_image_expired" });
    }
  });

  it("rejects a legacy image when a parent directory changes to an outside symlink before open", () => {
    const mediaRoot = path.join(dataRoot, "media", "tool-results");
    const insideDir = path.join(mediaRoot, "capture");
    const outsideDir = path.join(dataRoot, "outside-media");
    fs.mkdirSync(insideDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    const imagePath = path.join(insideDir, "screen.png");
    fs.writeFileSync(imagePath, Buffer.from(PNG_BASE64, "base64"));
    fs.writeFileSync(path.join(outsideDir, "screen.png"), Buffer.from(GIF_BASE64, "base64"));
    const service = new ComputerUseHistoryService({
      store: historyStore(), legacyMediaRoot: mediaRoot,
      sessions: { listSessionRecords: () => [{ key: "websocket:race", messages: [
        { role: "assistant", tool_calls: [{ id: "race-call", function: { name: "mcp_open_computer_use_get_app_state" } }] },
        { role: "tool", tool_call_id: "race-call", content: [{ type: "image_url", meta: { path: imagePath } }] },
      ] }] },
    });
    const originalOpen = fs.openSync;
    let swapped = false;
    const spy = vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (String(file) === imagePath && !swapped) {
        swapped = true;
        fs.renameSync(insideDir, `${insideDir}-saved`);
        fs.symlinkSync(outsideDir, insideDir);
      }
      return originalOpen(file, flags, mode);
    }) as typeof fs.openSync);
    try {
      const screenshot = service.list({ kind: "screenshot" }).events[0];
      expect(swapped).toBe(true);
      expect(screenshot.missingReason).toBe("legacy_image_outside_tool_media");
      expect(service.get(screenshot.id)?.screenshot).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("does not attach a transcript call to a different turn's most recent prompt", () => {
    const webuiRoot = path.join(dataRoot, "webui");
    fs.mkdirSync(webuiRoot, { recursive: true });
    fs.writeFileSync(path.join(webuiRoot, "websocket_chat.jsonl"), [
      { event: "user", turn_id: "turn-a", text: "First", createdAt: "2026-09-30T00:00:00.000Z" },
      { event: "user", turn_id: "turn-b", text: "Second", createdAt: "2026-09-30T00:00:01.000Z" },
      { event: "message", turn_id: "missing-turn", createdAt: "2026-09-30T00:00:02.000Z", tool_events: [{
        name: "mcp_open_computer_use_click", call_id: "transcript-call", result: "Clicked",
      }] },
    ].map((row) => JSON.stringify(row)).join("\n"));
    const service = new ComputerUseHistoryService({ store: historyStore(), transcriptsRoot: webuiRoot });
    const call = service.list({ kind: "tool_call" }).events[0];
    expect(call.source).toBe("transcript");
    expect(call.parentId).toBeNull();
    expect(call.metadata.turnId).toBe("missing-turn");
    expect(service.list({ turnId: "turn-b" }).events).toHaveLength(0);
  });
});
