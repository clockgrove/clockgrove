import type {
  BrowserScope,
  CommandId,
  ObjectId,
  SpaceId,
  WorldBootState,
} from "@clockgrove/contracts";
import { create } from "zustand";
import { reduceBoot, routeResolving, type WorldBootEvent } from "./world-boot.js";
import type { SceneEmphasis } from "./world-scene-adapter.js";

interface WorldBoot {
  /** The shell's one current boot state. */
  readonly boot: WorldBootState;
  /** Starts a new boot for a route; a directory-listed scope then resolves identity and membership. */
  readonly start: (route: string, listed: BrowserScope | undefined) => void;
  readonly advance: (event: WorldBootEvent) => void;
}
// Transient view state: the projection itself stays in Query.
export const useWorldBoot = create<WorldBoot>((set, get) => {
  let started = 0;
  return {
    // No route is known until the shell reads the location path and starts the first boot.
    boot: routeResolving("boot-0", "/"),
    start: (route, listed) => {
      set({ boot: routeResolving(`boot-${++started}`, route) });
      if (!listed) return;
      get().advance({ type: "identify", scope: listed });
      get().advance({ type: "authorize" });
    },
    // An inapplicable event keeps the same state, so subscribers see only transitions.
    advance: (event) =>
      set((state) => {
        const boot = reduceBoot(state.boot, event);
        return boot === state.boot ? state : { boot };
      }),
  };
});

interface WhyView {
  readonly commandId: CommandId | undefined;
  readonly explain: (commandId: CommandId | undefined) => void;
}
// Action intent has its own store so opening Why does not reselect the entity.
export const useWhyView = create<WhyView>((set) => ({
  commandId: undefined,
  explain: (commandId) => set({ commandId }),
}));

interface WorldChoice {
  /** The current world route path; the shell keeps it equal to the location path. */
  readonly path: string | undefined;
  readonly show: (path: string) => void;
}
// The selector's choice is transient and restored only from the shareable route.
export const useWorldChoice = create<WorldChoice>((set) => ({
  path: undefined,
  show: (path) => set({ path }),
}));

interface SceneView {
  /** The one shared selection: canvas picks and entity controls all write it. */
  readonly selected: ObjectId | undefined;
  readonly select: (objectId: ObjectId | undefined) => void;
}
// Transient view state only: deliberately no browser persistence middleware.
export const useSceneView = create<SceneView>((set) => ({
  selected: undefined,
  select: (selected) => {
    useWhyView.getState().explain(undefined);
    set({ selected });
  },
}));

interface EntityFocus {
  /** The entity whose control holds keyboard focus. */
  readonly focused: ObjectId | undefined;
  readonly focus: (objectId: ObjectId | undefined) => void;
}
export const useEntityFocus = create<EntityFocus>((set) => ({
  focused: undefined,
  focus: (focused) => set({ focused }),
}));

/** Passes the shared selection and focus to a renderer now and on each change of either. */
export function followEmphasis(emphasize: (emphasis: SceneEmphasis) => void): () => void {
  const current = (): SceneEmphasis => ({
    selected: useSceneView.getState().selected,
    focused: useEntityFocus.getState().focused,
  });
  emphasize(current());
  const stopSelection = useSceneView.subscribe((view, previous) => {
    if (view.selected !== previous.selected) emphasize(current());
  });
  const stopFocus = useEntityFocus.subscribe((view, previous) => {
    if (view.focused !== previous.focused) emphasize(current());
  });
  return () => {
    stopSelection();
    stopFocus();
  };
}

interface LayoutPanel {
  readonly open: boolean;
  readonly toggle: () => void;
  /** Opens the panel, as choosing a feed event opens the rail. */
  readonly show: () => void;
}
/** The shell desktop breakpoint; world-shell.css repeats it. */
export const DESKTOP_MEDIA = "(min-width: 1200px)";
const layout = () =>
  (globalThis.matchMedia?.(DESKTOP_MEDIA).matches ?? true) ? "desktop" : "narrow";

/**
 * A panel open by default at desktop and closed below the breakpoint (§4.4). Each layout keeps the
 * user's last choice, so crossing the breakpoint restores that layout's choice instead of forcing it.
 */
function layoutPanel() {
  const chosen = { desktop: true, narrow: false };
  const panel = create<LayoutPanel>((set) => {
    const choose = (open: boolean) => {
      chosen[layout()] = open;
      set({ open });
    };
    return {
      open: chosen[layout()],
      toggle: () => choose(!panel.getState().open),
      show: () => choose(true),
    };
  });
  globalThis.matchMedia?.(DESKTOP_MEDIA).addEventListener("change", ({ matches }) => {
    panel.setState({ open: chosen[matches ? "desktop" : "narrow"] });
  });
  return panel;
}
// Rail visibility is separate view state, so collapsing or reopening never changes the selection.
export const useEntityRail = layoutPanel();
export const useFeedSheet = layoutPanel();

interface ViewedSpace {
  /** The viewed place; undefined is the observed authority space itself. */
  readonly viewed: SpaceId | undefined;
  /** The latest navigation outcome, shown and announced as one message. */
  readonly notice: string | undefined;
  readonly show: (viewed: SpaceId | undefined, notice: string | undefined) => void;
  readonly reset: () => void;
}
// Transient navigation state only: no persistence, reset with the observed scope.
export const useViewedSpace = create<ViewedSpace>((set) => ({
  viewed: undefined,
  notice: undefined,
  show: (viewed, notice) => set({ viewed, notice }),
  reset: () => set({ viewed: undefined, notice: undefined }),
}));
