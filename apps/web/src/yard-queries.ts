import type {
  BrowserScope,
  ClientViewTrace,
  CommandId,
  EntitySelection,
  ObjectId,
  RecordedWhy,
  RecordedWhyEntry,
  SelectionCursor,
  WorldDirectory,
  WorldDirectoryEntry,
  WorldReadiness,
  WorldStatus,
} from "@clockgrove/contracts";
import { type QueryKey, type QueryState, skipToken, useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { ApiRefusal } from "./api.js";
import type { YardSession } from "./yard-api.js";
import { emptyYard, sameYardScope, type YardProjection } from "./yard-projection.js";

export const yardProjectionKey = ["living-yard", "projection"] as const;
// Keys describe public identity and intent only. Credential strings cannot occupy an ID slot.
export type DirectoryQueryKey = readonly ["living-yard", "directory", number];
export type EntityQueryKey = readonly [
  "living-yard",
  "entity",
  number,
  BrowserScope | undefined,
  number,
  ObjectId | undefined,
  SelectionCursor | undefined,
];
export type WhyQueryKey = readonly [
  "living-yard",
  "why",
  number,
  BrowserScope | undefined,
  number,
  ObjectId | undefined,
  number,
  RecordedWhyEntry | undefined,
];
export type ViewTraceQueryKey = readonly [
  "living-yard",
  "view-trace",
  number,
  BrowserScope | undefined,
  number,
  boolean,
];
export interface DirectoryProjection {
  readonly status: "signed out" | "signing in" | "ready" | "refused" | "unavailable";
  readonly entries: readonly WorldDirectoryEntry[];
}
export interface SelectionProjection {
  readonly objectId: ObjectId | undefined;
  readonly status: "none" | "loading" | "ready" | "unavailable";
  readonly value: EntitySelection | undefined;
}
export interface WhyProjection {
  readonly commandId: CommandId | undefined;
  readonly status: "none" | "loading" | "ready" | "unavailable" | "refused";
  readonly value: RecordedWhy | undefined;
}
export interface ViewTraceProjection {
  readonly status: "none" | "loading" | "ready" | "unavailable" | "refused";
  readonly value: ClientViewTrace | undefined;
}
export function directoryProjection(
  state: Pick<QueryState<WorldDirectory>, "status" | "data" | "error" | "fetchStatus"> | undefined,
): DirectoryProjection {
  if (state?.status === "success" && state.data)
    return { status: "ready", entries: state.data.entries };
  return {
    status:
      state?.status === "error"
        ? state.error instanceof ApiRefusal && state.error.status === 401
          ? "refused"
          : "unavailable"
        : state?.fetchStatus === "fetching"
          ? "signing in"
          : "signed out",
    entries: [],
  };
}
export function selectionProjection(
  objectId: ObjectId | undefined,
  state: Pick<QueryState<EntitySelection>, "status" | "data"> | undefined,
): SelectionProjection {
  return {
    objectId,
    status: !objectId
      ? "none"
      : state?.status === "success"
        ? "ready"
        : state?.status === "error"
          ? "unavailable"
          : "loading",
    value: state?.status === "success" ? state.data : undefined,
  };
}
export function whyProjection(
  entry: RecordedWhyEntry | undefined,
  state: Pick<QueryState<RecordedWhy>, "status" | "data" | "error"> | undefined,
): WhyProjection {
  const value = state?.status === "success" ? state.data : undefined;
  return {
    commandId: entry && "commandId" in entry ? entry.commandId : value?.commandId,
    status: !entry
      ? "none"
      : state?.status === "success"
        ? "ready"
        : state?.status === "error"
          ? state.error instanceof ApiRefusal && state.error.status === 429
            ? "refused"
            : "unavailable"
          : "loading",
    value,
  };
}
export function viewTraceProjection(
  active: boolean,
  state: Pick<QueryState<ClientViewTrace>, "status" | "data" | "error"> | undefined,
): ViewTraceProjection {
  return {
    status: !active
      ? "none"
      : state?.status === "success"
        ? "ready"
        : state?.status === "error"
          ? state.error instanceof ApiRefusal && state.error.status === 429
            ? "refused"
            : "unavailable"
          : "loading",
    value: state?.status === "success" ? state.data : undefined,
  };
}
// Disabled observers consume publications without initiating another request.
export function useYardProjection(session: YardSession): YardProjection {
  return (
    useQuery<YardProjection>({ queryKey: yardProjectionKey, queryFn: skipToken }, session.queries)
      .data ?? emptyYard
  );
}
function useReadKey<Key extends QueryKey>(session: YardSession, getKey: () => Key): Key {
  return useSyncExternalStore(session.subscribe, getKey, getKey);
}
export function useDirectoryQuery(session: YardSession): DirectoryProjection {
  const queryKey = useReadKey(session, session.getDirectoryKey);
  return directoryProjection(
    useQuery<WorldDirectory>({ queryKey, queryFn: skipToken }, session.queries),
  );
}
export function useSelectionQuery(session: YardSession): SelectionProjection {
  const queryKey = useReadKey(session, session.getSelectionKey);
  const query = useQuery<EntitySelection>({ queryKey, queryFn: skipToken }, session.queries);
  return selectionProjection(queryKey[5], query);
}
export type StatusQueryKey = readonly [
  "living-yard",
  "status",
  number,
  BrowserScope | undefined,
  string | undefined,
];
/**
 * The observed space's world status, read again for each committed revision the shell shows. The
 * previous answer stays visible during a refetch only within the same observation and scope.
 */
export function useWorldStatusQuery(
  session: YardSession,
  scope: BrowserScope | undefined,
  revision: string | undefined,
): WorldStatus | "unavailable" | undefined {
  const intent = useSyncExternalStore(session.subscribe, session.getIntent, session.getIntent);
  const queryKey: StatusQueryKey = ["living-yard", "status", intent, scope, revision];
  const query = useQuery<WorldStatus, Error, WorldStatus, StatusQueryKey>(
    {
      queryKey,
      queryFn:
        scope && revision !== undefined
          ? ({ signal }) => session.readWorldStatus(intent, scope, signal)
          : skipToken,
      staleTime: Number.POSITIVE_INFINITY,
      placeholderData: (previous, previousQuery) =>
        previousQuery?.queryKey[2] === intent &&
        previousQuery.queryKey[3] !== undefined &&
        scope !== undefined &&
        sameYardScope(previousQuery.queryKey[3], scope)
          ? previous
          : undefined,
    },
    session.queries,
  );
  return query.data ?? (query.isError ? "unavailable" : undefined);
}
export function useWhyQuery(session: YardSession): WhyProjection {
  const queryKey = useReadKey(session, session.getWhyKey);
  const query = useQuery<RecordedWhy>({ queryKey, queryFn: skipToken }, session.queries);
  return whyProjection(queryKey[7], query);
}
export function useViewTraceQuery(session: YardSession): ViewTraceProjection {
  const queryKey = useReadKey(session, session.getViewTraceKey);
  const query = useQuery<ClientViewTrace>({ queryKey, queryFn: skipToken }, session.queries);
  return viewTraceProjection(queryKey[5], query);
}
/**
 * A provisioning world's readiness is read again at this interval (decision): about one provisioning
 * step, and at most one indexed read per waiting viewer every two seconds. A failed or unreadable
 * world waits for Retry instead.
 */
export const READINESS_POLL_MS = 2000;
export type ReadinessProjection =
  | "checking"
  | "ready"
  | "provisioning"
  | "failed"
  | "refused"
  | "unavailable";
/** The routed world's readiness, while the directory does not list it; Retry reads it again. */
export function useWorldReadinessQuery(
  session: YardSession,
  scope: BrowserScope | undefined,
): { readonly readiness: ReadinessProjection; readonly retry: () => void } {
  const signIn = useReadKey(session, session.getDirectoryKey)[2];
  const query = useQuery<WorldReadiness>(
    {
      queryKey: ["living-yard", "readiness", signIn, scope],
      queryFn: scope ? ({ signal }) => session.readWorldReadiness(scope, signal) : skipToken,
      refetchInterval: (current) =>
        current.state.status === "success" && current.state.data?.readiness === "provisioning"
          ? READINESS_POLL_MS
          : false,
    },
    session.queries,
  );
  const readiness: ReadinessProjection = query.isError
    ? query.error instanceof ApiRefusal && query.error.status === 403
      ? "refused"
      : "unavailable"
    : (query.data?.readiness ?? "checking");
  return { readiness, retry: () => void query.refetch() };
}
