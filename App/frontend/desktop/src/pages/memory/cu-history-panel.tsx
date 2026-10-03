import { useEffect, useMemo, useRef, useState } from "react";
import { Brain, ChevronDown, Image as ImageIcon, MessageSquareText, ScanText, Wrench } from "lucide-react";
import type {
  CuHistoryEvent,
  CuHistoryEventDetail,
  CuHistoryKind,
  CuHistoryListOptions,
  MemmyAgentClient,
} from "../../api/memmy-agent-client.js";
import { MemmyAgentRequestError } from "../../api/memmy-agent-client.js";
import { useTranslation } from "../../i18n/use-translation.js";

const PAGE_SIZE = 50;
const TEXT_PREVIEW_LENGTH = 1_200;
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

type HistoryFilter = Pick<CuHistoryListOptions, "kind" | "from" | "to" | "sessionId" | "turnId">;
type Translate = ReturnType<typeof useTranslation>["t"];

export function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

export function eventKindLabel(kind: CuHistoryKind, t: Translate): string {
  const keys = {
    prompt: "computerHistory.raw.kind.prompt",
    reasoning: "computerHistory.raw.kind.reasoning",
    tool_call: "computerHistory.raw.kind.tool_call",
    ui_text: "computerHistory.raw.kind.ui_text",
    screenshot: "computerHistory.raw.kind.screenshot",
  } as const;
  return t(keys[kind]);
}

export function eventSourceLabel(source: CuHistoryEvent["source"], t: Translate): string {
  const keys = {
    recorder: "computerHistory.raw.source.recorder",
    session: "computerHistory.raw.source.session",
    transcript: "computerHistory.raw.source.transcript",
  } as const;
  return t(keys[source]);
}

export function EventKindIcon(props: { kind: CuHistoryKind }) {
  switch (props.kind) {
    case "prompt": return <MessageSquareText size={16} aria-hidden="true" />;
    case "reasoning": return <Brain size={16} aria-hidden="true" />;
    case "tool_call": return <Wrench size={16} aria-hidden="true" />;
    case "ui_text": return <ScanText size={16} aria-hidden="true" />;
    case "screenshot": return <ImageIcon size={16} aria-hidden="true" />;
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function missingReasonLabel(reason: string, t: Translate): string {
  switch (reason) {
    case "tool_result_pending": return t("computerHistory.raw.reason.pending");
    case "tool_outcome_unknown": return t("computerHistory.raw.reason.uncertain");
    case "tool_result_timeout": return t("computerHistory.raw.reason.timeout");
    case "tool_result_unavailable": return t("computerHistory.raw.reason.noResult");
    case "recorder_result_recovered_from_legacy": return t("computerHistory.raw.reason.recoveredFromLegacy");
    case "invalid_or_unavailable_image": return t("computerHistory.raw.reason.invalidImage");
    case "legacy_prompt_context_not_guaranteed": return t("computerHistory.raw.reason.legacyPrompt");
    case "legacy_tool_result_missing": return t("computerHistory.raw.reason.legacyNoResult");
    case "legacy_tool_result_may_be_truncated": return t("computerHistory.raw.reason.legacyResultTruncated");
    case "transcript_tool_result_is_sanitized": return t("computerHistory.raw.reason.transcriptSanitized");
    case "legacy_reasoning_may_be_truncated": return t("computerHistory.raw.reason.legacyReasoningTruncated");
    case "transcript_reasoning_is_sanitized": return t("computerHistory.raw.reason.transcriptReasoningSanitized");
    case "legacy_ui_text_may_be_truncated": return t("computerHistory.raw.reason.legacyUiTruncated");
    case "transcript_ui_text_is_sanitized": return t("computerHistory.raw.reason.transcriptUiSanitized");
    case "legacy_image_reference_only": return t("computerHistory.raw.reason.legacyImageReference");
    case "legacy_image_path_missing":
    case "legacy_image_outside_tool_media":
    case "legacy_image_unavailable":
    case "legacy_image_invalid":
    case "legacy_image_expired": return t("computerHistory.raw.reason.legacyImageMissing");
    default: return reason;
  }
}

export function callStatusLabel(status: string, t: Translate): string {
  const keys = {
    pending: "computerHistory.raw.status.pending",
    ok: "computerHistory.raw.status.ok",
    error: "computerHistory.raw.status.error",
    blocked: "computerHistory.raw.status.blocked",
    uncertain: "computerHistory.raw.status.uncertain",
    timeout: "computerHistory.raw.status.timeout",
    cancelled: "computerHistory.raw.status.cancelled",
    unknown: "computerHistory.raw.status.unknown",
  } as const;
  return status in keys ? t(keys[status as keyof typeof keys]) : status;
}

function imageErrorMessage(cause: unknown, t: Translate): string {
  if (cause instanceof MemmyAgentRequestError && (cause.status === 404 || cause.status === 410)) {
    return t("computerHistory.raw.imageGone");
  }
  return errorMessage(cause);
}

function toLocalDayBoundary(day: string, endOfDay: boolean): string | undefined {
  if (!day) return undefined;
  const date = new Date(`${day}T00:00:00`);
  if (Number.isNaN(date.getTime())) return undefined;
  if (endOfDay) date.setHours(23, 59, 59, 999);
  return date.toISOString();
}

export function asDisplayText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The raw event browser deliberately does not share the human summary snapshot or its screenshot policy. */
export function CuHistoryPanel(props: { client: MemmyAgentClient | null; standalone?: boolean }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [draftKind, setDraftKind] = useState<CuHistoryKind | "all">("all");
  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");
  const [draftSessionId, setDraftSessionId] = useState("");
  const [filter, setFilter] = useState<HistoryFilter>({});
  const [refreshNumber, setRefreshNumber] = useState(0);
  const [events, setEvents] = useState<CuHistoryEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [filterError, setFilterError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const morePending = useRef(false);
  const visibleEvents = useMemo(() => filter.sessionId
    ? [...events].sort((left, right) => left.orderKey.localeCompare(right.orderKey))
    : events, [events, filter.sessionId]);

  useEffect(() => {
    if (!expanded || !props.client) return;
    const controller = new AbortController();
    const version = ++requestVersion.current;
    morePending.current = false;
    setEvents([]);
    setNextCursor(null);
    setSelectedId(null);
    setListError(null);
    setListLoading(true);
    setMoreLoading(false);
    void props.client.listCuHistoryEvents({ ...filter, limit: PAGE_SIZE, signal: controller.signal })
      .then((page) => {
        if (version !== requestVersion.current) return;
        setEvents(page.events);
        setNextCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (version !== requestVersion.current || controller.signal.aborted) return;
        setListError(errorMessage(cause));
      })
      .finally(() => {
        if (version === requestVersion.current) setListLoading(false);
      });
    return () => {
      controller.abort();
      requestVersion.current += 1;
    };
  }, [expanded, filter, props.client, refreshNumber]);

  const applyFilters = () => {
    if (draftFrom && draftTo && draftFrom > draftTo) {
      setFilterError(t("computerHistory.raw.dateRangeError"));
      return;
    }
    setFilterError(null);
    setFilter({
      ...(draftKind === "all" ? {} : { kind: draftKind }),
      ...(draftFrom ? { from: toLocalDayBoundary(draftFrom, false) } : {}),
      ...(draftTo ? { to: toLocalDayBoundary(draftTo, true) } : {}),
      ...(draftSessionId.trim() ? { sessionId: draftSessionId.trim() } : {}),
    });
  };

  const clearFilters = () => {
    setDraftKind("all");
    setDraftFrom("");
    setDraftTo("");
    setDraftSessionId("");
    setFilterError(null);
    setFilter({});
  };

  const viewSession = (sessionId: string) => {
    setDraftKind("all");
    setDraftFrom("");
    setDraftTo("");
    setDraftSessionId(sessionId);
    setFilterError(null);
    setFilter({ sessionId });
  };

  const viewTurn = (sessionId: string, turnId: string) => {
    setDraftKind("all");
    setDraftFrom("");
    setDraftTo("");
    setDraftSessionId(sessionId);
    setFilterError(null);
    setFilter({ sessionId, turnId });
  };

  const loadMore = () => {
    if (!props.client || !nextCursor || listLoading || morePending.current) return;
    const version = requestVersion.current;
    const cursor = nextCursor;
    morePending.current = true;
    setMoreLoading(true);
    setListError(null);
    void props.client.listCuHistoryEvents({ ...filter, cursor, limit: PAGE_SIZE })
      .then((page) => {
        if (version !== requestVersion.current) return;
        setEvents((current) => {
          const ids = new Set(current.map((event) => event.id));
          return [...current, ...page.events.filter((event) => !ids.has(event.id))];
        });
        setNextCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (version === requestVersion.current) setListError(errorMessage(cause));
      })
      .finally(() => {
        if (version === requestVersion.current) {
          setMoreLoading(false);
          morePending.current = false;
        }
      });
  };

  return (
    <section className="ch-raw" aria-labelledby="cu-history-title">
      <div className="ch-raw__heading">
        <div>
          <h4 id="cu-history-title">{t("computerHistory.raw.title")}</h4>
          <p>{t(props.standalone ? "computerHistory.raw.descriptionStandalone" : "computerHistory.raw.description")}</p>
        </div>
        <button
          type="button"
          className="ch-raw__toggle"
          aria-expanded={expanded}
          aria-controls="cu-history-content"
          onClick={() => setExpanded((value) => !value)}
        >
          {t(expanded ? "computerHistory.raw.collapse" : "computerHistory.raw.open")}
          <ChevronDown size={16} className={expanded ? "ch-raw__chevron ch-raw__chevron--open" : "ch-raw__chevron"} aria-hidden="true" />
        </button>
      </div>

      {expanded ? <div id="cu-history-content">
        <div className="ch-raw__filters">
          <label>{t("computerHistory.raw.filterKind")}
            <select value={draftKind} onChange={(event) => setDraftKind(event.target.value as CuHistoryKind | "all")}>
              <option value="all">{t("computerHistory.raw.kind.all")}</option>
              <option value="prompt">{t("computerHistory.raw.kind.prompt")}</option>
              <option value="reasoning">{t("computerHistory.raw.kind.reasoning")}</option>
              <option value="tool_call">{t("computerHistory.raw.kind.tool_call")}</option>
              <option value="ui_text">{t("computerHistory.raw.kind.ui_text")}</option>
              <option value="screenshot">{t("computerHistory.raw.kind.screenshot")}</option>
            </select>
          </label>
          <label>{t("computerHistory.raw.from")}
            <input type="date" value={draftFrom} onChange={(event) => setDraftFrom(event.target.value)} />
          </label>
          <label>{t("computerHistory.raw.to")}
            <input type="date" value={draftTo} onChange={(event) => setDraftTo(event.target.value)} />
          </label>
          <label className="ch-raw__session-filter">{t("computerHistory.raw.sessionFilter")}
            <input type="text" value={draftSessionId} onChange={(event) => setDraftSessionId(event.target.value)} placeholder={t("computerHistory.raw.sessionPlaceholder")} />
          </label>
          <div className="ch-raw__filter-actions">
            <button type="button" onClick={applyFilters}>{t("computerHistory.raw.apply")}</button>
            <button type="button" onClick={clearFilters}>{t("computerHistory.raw.reset")}</button>
            <button type="button" onClick={() => setRefreshNumber((value) => value + 1)}>{t("common.refresh")}</button>
          </div>
        </div>
        {filterError ? <p className="ch-raw__error" role="alert">{filterError}</p> : null}
        {listError ? <p className="ch-raw__error" role="alert">{t("computerHistory.raw.loadFailed", { error: listError })}</p> : null}
        {!props.client ? <p className="ch-raw__status" role="status">{t("computerHistory.raw.unavailable")}</p> : null}
        {props.client && listLoading ? <p className="ch-raw__status" role="status">{t("common.loading")}</p> : null}
        {props.client && !listLoading && !listError && events.length === 0 ? <p className="ch-raw__status">{t("computerHistory.raw.empty")}</p> : null}

        {events.length && props.client ? <div className="ch-raw__layout">
          <div className="ch-raw__event-column">
            {filter.sessionId ? <div className="ch-raw__session-timeline">
              <div>
                <strong>{t(filter.turnId ? "computerHistory.raw.turnTimeline" : "computerHistory.raw.sessionTimeline")}</strong>
                <span>{t(filter.turnId ? "computerHistory.raw.turnTimelineDescription" : "computerHistory.raw.sessionTimelineDescription")}</span>
              </div>
              <div className="ch-raw__timeline-actions">
                {filter.turnId ? <button type="button" onClick={() => viewSession(filter.sessionId!)}>{t("computerHistory.raw.backToSession")}</button> : null}
                <button type="button" onClick={clearFilters}>{t("computerHistory.raw.allSessions")}</button>
              </div>
            </div> : null}
            {filter.sessionId && nextCursor ? <button type="button" className="ch-raw__more" disabled={moreLoading} onClick={loadMore}>
              {t(moreLoading ? "common.loading" : "computerHistory.raw.loadEarlier")}
            </button> : null}
            <div className={filter.sessionId ? "ch-raw__list ch-raw__list--timeline" : "ch-raw__list"} aria-label={t(filter.turnId ? "computerHistory.raw.turnTimeline" : filter.sessionId ? "computerHistory.raw.sessionTimeline" : "computerHistory.raw.eventList")}>
              {visibleEvents.map((event) => <button
                key={event.id}
                type="button"
                className={selectedId === event.id ? "ch-raw__event ch-raw__event--selected" : "ch-raw__event"}
                aria-pressed={selectedId === event.id}
                onClick={() => setSelectedId(event.id)}
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
                    <span>{eventSourceLabel(event.source, t)}</span>
                    {event.completeness === "partial" ? <span className="ch-raw__partial">{t("computerHistory.raw.partial")}</span> : null}
                  </span>
                </span>
              </button>)}
            </div>
            {!filter.sessionId && nextCursor ? <button type="button" className="ch-raw__more" disabled={moreLoading} onClick={loadMore}>
              {t(moreLoading ? "common.loading" : "computerHistory.raw.loadMore")}
            </button> : null}
          </div>
          <CuHistoryDetail
            client={props.client}
            eventId={selectedId}
            fallback={events.find((event) => event.id === selectedId) ?? null}
            onViewSession={viewSession}
            onViewTurn={viewTurn}
            onViewParent={setSelectedId}
          />
        </div> : null}
      </div> : null}
    </section>
  );
}

export function CuHistoryDetail(props: {
  client: MemmyAgentClient;
  eventId: string | null;
  fallback: CuHistoryEvent | null;
  onViewSession?: (sessionId: string) => void;
  onViewTurn?: (sessionId: string, turnId: string) => void;
  onViewParent?: (eventId: string) => void;
}) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<CuHistoryEventDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.eventId) {
      setDetail(null);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setDetail(null);
    setError(null);
    setLoading(true);
    void props.client.getCuHistoryEvent(props.eventId, { signal: controller.signal })
      .then((next) => { if (!controller.signal.aborted) setDetail(next); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(errorMessage(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [props.client, props.eventId]);

  if (!props.eventId) return <aside className="ch-raw__detail ch-raw__detail--empty">{t("computerHistory.raw.selectEvent")}</aside>;
  if (loading) return <aside className="ch-raw__detail" role="status">{t("common.loading")}</aside>;
  if (error) return <aside className="ch-raw__detail ch-raw__error" role="alert">{t("computerHistory.raw.detailFailed", { error })}</aside>;
  if (!detail) return <aside className="ch-raw__detail">{props.fallback?.summary ?? t("computerHistory.raw.selectEvent")}</aside>;
  const turnId = typeof detail.metadata.turnId === "string" && detail.metadata.turnId ? detail.metadata.turnId : null;
  const callStatus = typeof detail.metadata.status === "string" ? detail.metadata.status : null;
  const screenshotCount = typeof detail.metadata.screenshotCount === "number" ? detail.metadata.screenshotCount : null;

  return <aside className="ch-raw__detail" aria-label={t("computerHistory.raw.eventDetail")}>
    <div className="ch-raw__detail-heading">
      <span className="ch-raw__detail-kind"><EventKindIcon kind={detail.kind} />{eventKindLabel(detail.kind, t)}</span>
      <time dateTime={detail.timestamp}>{formatTime(detail.timestamp)}</time>
    </div>
    <h3>{detail.title}</h3>
    {detail.summary ? <p className="ch-raw__detail-summary">{detail.summary}</p> : null}
    <dl className="ch-raw__facts">
      <div><dt>{t("computerHistory.raw.source")}</dt><dd>{eventSourceLabel(detail.source, t)}</dd></div>
      {detail.sessionId ? <div><dt>{t("computerHistory.raw.session")}</dt><dd>{detail.sessionId}{props.onViewSession || (turnId && props.onViewTurn) ? <span className="ch-raw__detail-actions">{props.onViewSession ? <button type="button" className="ch-raw__view-session" onClick={() => props.onViewSession?.(detail.sessionId!)}>{t("computerHistory.raw.showSession")}</button> : null}{turnId && props.onViewTurn ? <button type="button" className="ch-raw__view-session" onClick={() => props.onViewTurn?.(detail.sessionId!, turnId)}>{t("computerHistory.raw.showTurn")}</button> : null}</span> : null}</dd></div> : null}
      {detail.parentId ? <div><dt>{t("computerHistory.raw.parent")}</dt><dd>{detail.parentId}{props.onViewParent ? <button type="button" className="ch-raw__view-session" onClick={() => props.onViewParent?.(detail.parentId!)}>{t("computerHistory.raw.showParent")}</button> : null}</dd></div> : null}
      {callStatus ? <div><dt>{t("computerHistory.raw.callStatus")}</dt><dd>{callStatusLabel(callStatus, t)}</dd></div> : null}
      <div><dt>{t("computerHistory.raw.completeness")}</dt><dd>{t(detail.completeness === "partial" ? "computerHistory.raw.partial" : "computerHistory.raw.complete")}</dd></div>
    </dl>
    {detail.missingReason ? <p className="ch-raw__missing" role="note" title={detail.missingReason}>{missingReasonLabel(detail.missingReason, t)}</p> : null}
    {detail.kind === "tool_call" && detail.source === "recorder" && callStatus && callStatus !== "pending" && screenshotCount === 0
      ? <p className="ch-raw__evidence-note" role="status">{t("computerHistory.raw.noToolScreenshot")}</p> : null}
    {detail.kind === "tool_call" && detail.source === "recorder" && screenshotCount !== null && screenshotCount > 0
      ? <p className="ch-raw__evidence-note">{t("computerHistory.raw.toolScreenshotCount", { count: screenshotCount })}</p> : null}
    {detail.text ? <ExpandableText label={t("computerHistory.raw.text")} text={detail.text} /> : null}
    {detail.args ? <ExpandableText label={t("computerHistory.raw.arguments")} text={asDisplayText(detail.args)} /> : null}
    {detail.result !== null && detail.result !== undefined ? <ExpandableText label={t("computerHistory.raw.result")} text={asDisplayText(detail.result)} /> : null}
    {detail.screenshot ? <ScreenshotPreview client={props.client} assetId={detail.screenshot.assetId} title={detail.title} />
      : detail.kind === "screenshot" && !detail.missingReason ? <p className="ch-raw__missing" role="status">{t("computerHistory.raw.imageMissing")}</p> : null}
    {Object.keys(detail.metadata).length ? <ExpandableText label={t("computerHistory.raw.metadata")} text={asDisplayText(detail.metadata)} /> : null}
  </aside>;
}

function ExpandableText(props: { label: string; text: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [props.text]);
  const long = props.text.length > TEXT_PREVIEW_LENGTH;
  const shown = long && !expanded ? `${props.text.slice(0, TEXT_PREVIEW_LENGTH)}…` : props.text;
  return <section className="ch-raw__content-block">
    <h4>{props.label}</h4>
    <pre>{shown}</pre>
    {long ? <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      {t(expanded ? "computerHistory.raw.showLess" : "computerHistory.raw.showAll")}
    </button> : null}
  </section>;
}

function ScreenshotPreview(props: { client: MemmyAgentClient; assetId: string; title: string }) {
  const { t } = useTranslation();
  const [source, setSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [large, setLarge] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setSource(null);
    setError(null);
    setLarge(false);
    setLoading(true);
    void props.client.getCuHistoryAsset(props.assetId, { signal: controller.signal })
      .then(({ mimeType, dataBase64 }) => {
        if (controller.signal.aborted) return;
        if (!IMAGE_MIME_TYPES.has(mimeType) || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) {
          throw new Error(t("computerHistory.raw.invalidImage"));
        }
        setSource(`data:${mimeType};base64,${dataBase64}`);
      })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(imageErrorMessage(cause, t)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [props.assetId, props.client, t]);

  return <section className="ch-raw__image-block">
    <h4>{t("computerHistory.raw.image")}</h4>
    {loading ? <p role="status">{t("common.loading")}</p> : null}
    {error ? <p className="ch-raw__missing" role="status">{t("computerHistory.raw.imageFailed", { error })}</p> : null}
    {source ? <>
      <button type="button" className="ch-raw__image-toggle" aria-expanded={large} onClick={() => setLarge((value) => !value)}>
        {t(large ? "computerHistory.raw.shrinkImage" : "computerHistory.raw.expandImage")}
      </button>
      <div className={large ? "ch-raw__image-frame ch-raw__image-frame--large" : "ch-raw__image-frame"}>
        <img
          src={source}
          alt={t("computerHistory.raw.imageAlt", { title: props.title })}
          onError={() => {
            setSource(null);
            setError(t("computerHistory.raw.invalidImage"));
          }}
        />
      </div>
    </> : null}
  </section>;
}
