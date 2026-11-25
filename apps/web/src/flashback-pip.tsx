import type { Flashback, SceneProjection } from "@clockgrove/contracts";
import { useEffect, useRef, useState } from "react";
import {
  FLASHBACK_FRAME_MS,
  FLASHBACK_PIP_BUDGET,
  FLASHBACK_PIP_LIMITS,
  type QualityTier,
  TIERS,
} from "./quality-tier.js";
import type { RendererContent } from "./renderer-content.js";
import type { WorldSceneAdapter } from "./world-scene-adapter.js";

const reducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Issue 273: the flashback's one picture-in-picture renderer, kept while the flashback is open, so
 * stepping back through causes, retrying or going back loads each moment's journaled frames into
 * the same renderer rather than building a new one (a device, its shaders and textures) each time.
 * It is created on the first replay that has a budget and released when the flashback closes, a
 * replay has no budget, the renderer fails or the content changes.
 */
export class FlashbackStage {
  /** The element the renderer draws into; a replay places it in its own slot while it shows. */
  readonly host: HTMLDivElement = document.createElement("div");
  private created: WorldSceneAdapter | undefined;
  private ready: WorldSceneAdapter | undefined;
  private starting = false;
  private content: RendererContent | undefined;
  private projection: SceneProjection | undefined;
  private dayLength: bigint | undefined;
  private failure: (() => void) | undefined;
  private generation = 0;

  /** Starts the renderer unless one already runs for this content; `failed` hears a loss. */
  start(content: RendererContent | undefined, failed: () => void): void {
    this.failure = failed;
    if ((this.created !== undefined || this.starting) && content === this.content) return;
    this.stop();
    this.content = content;
    const generation = this.generation;
    this.starting = true;
    void import("./renderer.js")
      .then(({ ThreeWorldSceneAdapter }) => {
        if (generation !== this.generation) return;
        this.starting = false;
        const renderer: WorldSceneAdapter = new ThreeWorldSceneAdapter(
          this.host,
          () => {
            if (generation !== this.generation || this.created !== renderer) return;
            try {
              renderer.setReducedMotion(true);
              renderer.setDayLength(this.dayLength);
              if (this.projection) renderer.loadSnapshot(this.projection);
              this.ready = renderer;
            } catch {
              this.lose(generation);
            }
          },
          () => this.lose(generation),
          () => {},
          content,
          FLASHBACK_PIP_LIMITS,
        );
        // A renderer that failed while it was being constructed is not kept.
        if (generation === this.generation) this.created = renderer;
        else renderer.destroy();
      })
      .catch(() => this.lose(generation));
  }
  /** Draws one journaled frame, now if the renderer is ready, else once it is. */
  show(projection: SceneProjection): void {
    this.projection = projection;
    if (!this.ready) return;
    try {
      this.ready.loadSnapshot(projection);
    } catch {
      this.lose(this.generation);
    }
  }
  setDayLength(dayLengthMs: bigint | undefined): void {
    this.dayLength = dayLengthMs;
    this.ready?.setDayLength(dayLengthMs);
  }
  /** Releases the renderer; the next start builds a new one. */
  stop(): void {
    this.generation += 1;
    this.starting = false;
    this.ready = undefined;
    this.created?.destroy();
    this.created = undefined;
  }
  private lose(generation: number): void {
    if (generation !== this.generation) return;
    const failed = this.failure;
    this.stop();
    failed?.();
  }
}

/**
 * Issue 273: the tier the PiP is sized by, the lowest live tier seen while the flashback is open,
 * given the one held so far. A live step down that removes the PiP keeps it removed until the
 * flashback closes, across chain steps, so a recovering live tier cannot recreate it. With no live
 * canvas there is no PiP, but the lowest tier seen is kept.
 */
export function pipTierHeld(
  tier: QualityTier | undefined,
  lowest: QualityTier | undefined,
): { readonly held: QualityTier | undefined; readonly lowest: QualityTier | undefined } {
  if (tier === undefined) return { held: undefined, lowest };
  const next = lowest === undefined || TIERS.indexOf(tier) < TIERS.indexOf(lowest) ? tier : lowest;
  return { held: next, lowest: next };
}

/**
 * Issue 273: plays a flashback's journaled frames picture-in-picture in the flashback's one
 * renderer (FlashbackStage) while the live scene keeps running. The PiP's size follows the live
 * tier's budget; without one, the frame captions and the panel's text summary are the floor.
 * Reduced motion draws each journaled frame as it was, never a position between two of them.
 */
export function FlashbackReplay({
  flashback,
  stage,
  tier,
  held,
  failed,
  onFailed,
  content,
  dayLengthMs,
}: {
  readonly flashback: Flashback;
  readonly stage: FlashbackStage;
  /** The live tier now. */
  readonly tier: QualityTier | undefined;
  /** The lowest live tier seen while the flashback is open (pipTierHeld), which sizes the PiP. */
  readonly held: QualityTier | undefined;
  /** Whether the PiP's renderer failed while the flashback is open. */
  readonly failed: boolean;
  readonly onFailed: () => void;
  readonly content?: RendererContent;
  readonly dayLengthMs: bigint | undefined;
}) {
  const frames = flashback.frames;
  const last = frames.length - 1;
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(() => !reducedMotion());
  const slot = useRef<HTMLDivElement>(null);
  const budget = held === undefined ? null : FLASHBACK_PIP_BUDGET[held];
  const shown = budget !== null && !failed;

  useEffect(() => {
    if (!playing || index >= last) {
      if (playing && index >= last) setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setIndex(index + 1), FLASHBACK_FRAME_MS);
    return () => clearTimeout(timer);
  }, [playing, index, last]);

  useEffect(() => {
    if (budget === null) stage.stop();
  }, [budget, stage]);

  useEffect(() => {
    const at = slot.current;
    if (!shown || !at || held === undefined || budget === null) return;
    const host = stage.host;
    host.className = "rw-flashback-pip";
    host.setAttribute("aria-hidden", "true");
    host.style.width = `${budget.width}px`;
    host.style.height = `${budget.height}px`;
    host.dataset.pipTier = held;
    at.appendChild(host);
    stage.start(content, onFailed);
    return () => host.remove();
  }, [shown, held, budget, stage, content, onFailed]);

  useEffect(() => {
    stage.setDayLength(dayLengthMs);
  }, [stage, dayLengthMs]);

  useEffect(() => {
    const frame = frames[index];
    if (frame) stage.show(frame.projection);
  }, [stage, index, frames]);

  if (frames.length === 0) return null;
  const frame = frames[index] ?? frames[0];
  if (!frame) return null;
  return (
    <section aria-label="Flashback replay" className="rw-flashback-replay">
      {shown ? (
        <div ref={slot} className="rw-flashback-pip-slot" />
      ) : failed && budget ? (
        <p>Replay canvas unavailable. The frame captions and summary remain.</p>
      ) : held === undefined ? (
        <p>Picture-in-picture needs the live canvas; the frame captions and summary remain.</p>
      ) : held !== tier ? (
        <p>
          Picture-in-picture stopped when the live view slowed; the frame captions and summary
          remain.
        </p>
      ) : (
        <p>
          Picture-in-picture is off at this quality tier; the frame captions and summary remain.
        </p>
      )}
      <div>
        <button
          type="button"
          onClick={() => {
            if (playing) setPlaying(false);
            else {
              if (index >= last) setIndex(0);
              setPlaying(true);
            }
          }}
        >
          {playing ? "Pause replay" : "Play replay"}
        </button>
        <button
          type="button"
          onClick={() => {
            setIndex(0);
            setPlaying(true);
          }}
        >
          Replay from start
        </button>
        <input
          type="range"
          aria-label="Flashback frame"
          min={1}
          max={frames.length}
          value={index + 1}
          onChange={(event) => {
            setIndex(Number(event.currentTarget.value) - 1);
            setPlaying(false);
          }}
        />
      </div>
      <p data-flashback-frame={index}>
        {`Frame ${index + 1} of ${frames.length}: after command ${frame.commandId}, partition sequence ${frame.partitionSequence}${frame.moment ? ", the moment" : ""}.`}
      </p>
      <p>Positions between frames were not recorded and are not drawn.</p>
    </section>
  );
}
