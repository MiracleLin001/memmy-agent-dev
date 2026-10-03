import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CuHistoryEvent, MemmyAgentClient } from "../../api/memmy-agent-client.js";
import {
  callStatusLabel,
  CuHistoryDetail,
  EventKindIcon,
  eventKindLabel,
  eventSourceLabel,
  formatTime,
} from "./cu-history-panel.js";
import { useTranslation } from "../../i18n/use-translation.js";

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const UNASSIGNED_SESSION = "__unassigned__";

type Translate = ReturnType<typeof useTranslation>["t"];

interface StitchedHistory {
  key: string;
  sessionId: string | null;
  title: string;
  summary: string;
  events: CuHistoryEvent[];
  startedAt: string;
  updatedAt: string;
  complete: boolean;
  incompleteCount: number;
  turnCount: number;
  reasoningCount: number;
  toolCallCount: number;
  screenshotCount: number;
}

function sortEvents(events: CuHistoryEvent[]): CuHistoryEvent[] {
  return [...events].sort((left, right) => left.orderKey.localeCompare(right.orderKey) || left.id.localeCompare(right.id));
}

async function readAllEvents(client: MemmyAgentClient, signal: AbortSignal): Promise<CuHistoryEvent[]> {
  const events: CuHistoryEvent[] = [];
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
    const page = await client.listCuHistoryEvents({ limit: PAGE_SIZE, cursor, signal });
    events.push(...page.events);
    if (!page.nextCursor) return events;
    cursor = page.nextCursor;
  }
  throw new Error("Computer Use history is too large to stitch in one view");
}

function buildHistories(events: CuHistoryEvent[], t: Translate): StitchedHistory[] {
  const grouped = new Map<string, CuHistoryEvent[]>();
  for (const event of events) {
    const key = event.sessionId ?? UNASSIGNED_SESSION;
    const current = grouped.get(key) ?? [];
    current.push(event);
    grouped.set(key, current);
  }

  return [...grouped.entries()]
    .map(([key, rows]) => {
      const ordered = sortEvents(rows);
      const prompt = ordered.find((event) => event.kind === "prompt");
      const startedAt = ordered[0]?.timestamp ?? "";
      const updatedAt = ordered.at(-1)?.timestamp ?? startedAt;
      const turnIds = new Set(ordered
        .map((event) => event.metadata.turnId)
        .filter((turnId): turnId is string => typeof turnId === "string" && turnId.length > 0));
      const incompleteCount = ordered.filter((event) => event.completeness !== "complete").length;
      return {
        key,
        sessionId: key === UNASSIGNED_SESSION ? null : key,
        title: prompt?.summary?.trim() || t("computerHistory.stitched.untitled"),
        summary: prompt?.summary?.trim() || ordered[0]?.summary || t("computerHistory.stitched.untitled"),
        events: ordered,
        startedAt,
        updatedAt,
        complete: incompleteCount === 0,
        incompleteCount,
        turnCount: turnIds.size,
        reasoningCount: ordered.filter((event) => event.kind === "reasoning").length,
        toolCallCount: ordered.filter((event) => event.kind === "tool_call").length,
        screenshotCount: ordered.filter((event) => event.kind === "screenshot").length,
      } satisfies StitchedHistory;
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.key.localeCompare(left.key));
}

function eventStatus(event: CuHistoryEvent, t: Translate): string {
  if (event.kind === "tool_call" && typeof event.metadata.status === "string") {
    return callStatusLabel(event.metadata.status, t);
  }
  return eventSourceLabel(event.source, t);
}

export function CuHistoryStitchedPanel(props: { client: MemmyAgentClient | null }) {
  const { t } = useTranslation();
  const [histories, setHistories] = useState<StitchedHistory[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshNumber, setRefreshNumber] = useState(0);

  useEffect(() => {
    if (!props.client) {
      setHistories([]);
      setSelectedKey(null);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void readAllEvents(props.client, controller.signal)
      .then((events) => setHistories(buildHistories(events, t)))
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [props.client, refreshNumber, t]);

  useEffect(() => {
    setSelectedKey((current) => current && histories.some((history) => history.key === current)
      ? current
      : histories[0]?.key ?? null);
  }, [histories]);

  const selected = useMemo(
    () => histories.find((history) => history.key === selectedKey) ?? null,
    [histories, selectedKey],
  );

  useEffect(() => {
    setSelectedEventId(selected?.events[0]?.id ?? null);
  }, [selected?.key]);

  return (
    <section className="ch-raw ch-stitched" aria-labelledby="cu-stitched-history-title">
      <div className="ch-raw__heading">
        <div>
          <h4 id="cu-stitched-history-title">{t("computerHistory.stitched.title")}</h4>
          <p>{t("computerHistory.stitched.description")}</p>
        </div>
        <button
          type="button"
          className="ch-stitched__refresh"
          onClick={() => setRefreshNumber((value) => value + 1)}
          disabled={loading || !props.client}
        >
          <RefreshCw size={14} aria-hidden="true" />
          {t("common.refresh")}
        </button>
      </div>

      {!props.client ? <p className="ch-raw__status" role="status">{t("computerHistory.stitched.unavailable")}</p> : null}
      {props.client && loading ? <p className="ch-raw__status" role="status">{t("common.loading")}</p> : null}
      {error ? <p className="ch-raw__error" role="alert">{t("computerHistory.stitched.loadFailed", { error })}</p> : null}
      {props.client && !loading && !error && histories.length === 0
        ? <p className="ch-raw__status" role="status">{t("computerHistory.stitched.empty")}</p>
        : null}

      {histories.length ? <>
        <div className="ch-stitched__entries" aria-label={t("computerHistory.stitched.conversations")}>
          {histories.map((history) => (
            <button
              key={history.key}
              type="button"
              className={selectedKey === history.key ? "ch-stitched__entry ch-stitched__entry--selected" : "ch-stitched__entry"}
              aria-pressed={selectedKey === history.key}
              onClick={() => setSelectedKey(history.key)}
            >
              <span className="ch-stitched__entry-heading">
                <strong>{history.title}</strong>
                <span className={history.complete ? "ch-stitched__badge" : "ch-stitched__badge ch-stitched__badge--partial"}>
                  {history.complete
                    ? t("computerHistory.stitched.complete")
                    : t("computerHistory.stitched.partial", { count: history.incompleteCount })}
                </span>
              </span>
              <span className="ch-stitched__entry-summary">{history.summary}</span>
              <span className="ch-stitched__entry-meta">
                <span>{t("computerHistory.stitched.entryMeta", {
                  events: history.events.length,
                  turns: history.turnCount,
                  reasoning: history.reasoningCount,
                  tools: history.toolCallCount,
                  screenshots: history.screenshotCount,
                })}</span>
                <time dateTime={history.updatedAt}>{formatTime(history.updatedAt)}</time>
              </span>
            </button>
          ))}
        </div>

        {selected ? <div className="ch-stitched__timeline" aria-labelledby="cu-stitched-timeline-title">
          <div className="ch-stitched__timeline-heading">
            <div>
              <h5 id="cu-stitched-timeline-title">{t("computerHistory.stitched.timeline")}</h5>
              <strong>{selected.title}</strong>
              <span>{t("computerHistory.stitched.timelineMeta", {
                started: formatTime(selected.startedAt),
                ended: formatTime(selected.updatedAt),
                events: selected.events.length,
              })}</span>
            </div>
            <span className={selected.complete ? "ch-stitched__badge" : "ch-stitched__badge ch-stitched__badge--partial"}>
              {selected.complete
                ? t("computerHistory.stitched.complete")
                : t("computerHistory.stitched.partial", { count: selected.incompleteCount })}
            </span>
          </div>
          <div className="ch-raw__layout">
            <div className="ch-raw__event-column">
              <div className="ch-raw__list ch-raw__list--timeline" aria-label={t("computerHistory.stitched.timeline")}>
                {selected.events.map((event) => (
                  <button
                    key={event.id}
                    type="button"
                    className={selectedEventId === event.id ? "ch-raw__event ch-raw__event--selected" : "ch-raw__event"}
                    aria-pressed={selectedEventId === event.id}
                    onClick={() => setSelectedEventId(event.id)}
                  >
                    <span className="ch-raw__event-icon"><EventKindIcon kind={event.kind} /></span>
                    <span className="ch-raw__event-main">
                      <span className="ch-raw__event-topline">
                        <span className="ch-raw__kind">{eventKindLabel(event.kind, t)}</span>
                        <time dateTime={event.timestamp}>{formatTime(event.timestamp)}</time>
                      </span>
                      <strong>{event.title}</strong>
                      {event.summary ? <span className="ch-raw__event-summary">{event.summary}</span> : null}
                      <span className="ch-raw__event-bottomline">
                        <span>{eventStatus(event, t)}</span>
                        {event.completeness === "partial" ? <span className="ch-raw__partial">{t("computerHistory.raw.partial")}</span> : null}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <CuHistoryDetail
              client={props.client!}
              eventId={selectedEventId}
              fallback={selected.events.find((event) => event.id === selectedEventId) ?? null}
              onViewParent={setSelectedEventId}
            />
          </div>
        </div> : <p className="ch-raw__status">{t("computerHistory.stitched.select")}</p>}
      </> : null}
    </section>
  );
}
