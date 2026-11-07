import { CompositionError, type DomainIssue } from "../components/registry/index.js";
import type { WorldState } from "../world.js";
import { compareText } from "./parse.js";
import { regionContains, type SpatialRegion, shapeDimensions } from "./region.js";

/**
 * Graph-shape issues of the semantic place hierarchy (graph 5 of the Wave 1 spatial model): the
 * `parent` references of `regions`, kept apart from containment, geometry and portals. Paths are
 * `<path>[i].parent...`: `cross-world` at `.worldId` and `cross-timeline` at `.timelineId` (checked
 * only with a `scope`), `unknown-parent` at `.regionId` (no such region) or `.version` (another
 * version), and `parent-cycle` at `.parent` for every region on a cycle. Issues are ordered by
 * region index, then path and code.
 */
export function semanticHierarchyIssues(
  regions: readonly SpatialRegion[],
  scope: { readonly worldId: string; readonly timelineId: string } | undefined,
  path: string,
): DomainIssue[] {
  const issues: DomainIssue[] = [];
  const byId = new Map(regions.map((region) => [region.regionId, region]));
  regions.forEach((region, index) => {
    const parent = region.parent;
    if (parent === undefined) return;
    const own: DomainIssue[] = [];
    const issue = (code: string, at: string, message: string) =>
      own.push({ code, path: at, message });
    const at = `${path}[${index}].parent`;
    if (scope !== undefined && parent.worldId !== undefined && parent.worldId !== scope.worldId)
      issue("cross-world", `${at}.worldId`, "a semantic parent belongs to the same world");
    if (
      scope !== undefined &&
      parent.timelineId !== undefined &&
      parent.timelineId !== scope.timelineId
    )
      issue("cross-timeline", `${at}.timelineId`, "a semantic parent belongs to the same timeline");
    const found = byId.get(parent.regionId);
    if (found === undefined)
      issue("unknown-parent", `${at}.regionId`, "does not reference a declared region");
    else if (found.version !== parent.version)
      issue("unknown-parent", `${at}.version`, "does not reference the declared region version");
    const seen = new Set<string>();
    for (let next: SpatialRegion | undefined = region; next?.parent !== undefined; ) {
      if (seen.has(next.regionId)) break;
      seen.add(next.regionId);
      next = byId.get(next.parent.regionId);
      if (next === region) {
        issue("parent-cycle", at, "the semantic hierarchy must be acyclic");
        break;
      }
    }
    // By region index as a number (`[10]` after `[2]`), then path and code within the region.
    issues.push(
      ...own.sort(
        (left, right) => compareText(left.path, right.path) || compareText(left.code, right.code),
      ),
    );
  });
  return issues;
}

/** Throws the first semantic hierarchy issue of the state as a `CompositionError`. */
export function validateSemanticHierarchy(state: WorldState): void {
  const first = semanticHierarchyIssues(
    state.spatialRegions ?? [],
    state,
    "state.spatialRegions",
  )[0];
  if (first !== undefined) throw new CompositionError(first.code, first.path, first.message);
}

/** The semantic ancestors of a region, nearest first (the hierarchy must be valid). */
export function regionAncestors(regions: readonly SpatialRegion[], regionId: string): string[] {
  const byId = new Map(regions.map((region) => [region.regionId, region]));
  const ancestors: string[] = [];
  for (let parent = byId.get(regionId)?.parent; parent !== undefined; ) {
    if (ancestors.includes(parent.regionId) || parent.regionId === regionId) break;
    ancestors.push(parent.regionId);
    parent = byId.get(parent.regionId)?.parent;
  }
  return ancestors;
}

/**
 * The place a point stands in: of the regions containing it (same frame, version and dimensions),
 * the one with the most semantic ancestors, ties by ascending region id; undefined outside all.
 */
export function placeOf(
  regions: readonly SpatialRegion[],
  frameId: string,
  frameVersion: number,
  coordinates: readonly bigint[],
): string | undefined {
  let best: { readonly regionId: string; readonly depth: number } | undefined;
  for (const region of regions) {
    if (
      region.frameId !== frameId ||
      region.frameVersion !== frameVersion ||
      shapeDimensions(region.shape) !== coordinates.length ||
      !regionContains(region, coordinates)
    )
      continue;
    const depth = regionAncestors(regions, region.regionId).length;
    if (
      best === undefined ||
      depth > best.depth ||
      (depth === best.depth && compareText(region.regionId, best.regionId) < 0)
    )
      best = { regionId: region.regionId, depth };
  }
  return best?.regionId;
}
