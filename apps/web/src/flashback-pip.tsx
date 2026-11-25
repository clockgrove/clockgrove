import type { Flashback } from "@clockgrove/contracts";
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
 * Issue 273: plays a flashback's journaled frames picture-in-picture in a second renderer while the
 * live scene keeps running. The PiP's size follows the live tier's budget; without one, the frame
 * captions and the panel's text summary are the floor. Reduced motion draws each journaled frame
 * as it was, never a position between two of them.
 */
export function FlashbackReplay({
  flashback,
  tier,
  content,
  dayLengthMs,
}: {
  readonly flashback: Flashback;
  readonly tier: QualityTier | undefined;
  readonly content?: RendererContent;
  readonly dayLengthMs: bigint | undefined;
}) {
  const frames = flashback.frames;
  const last = frames.length - 1;
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(() => !reducedMotion());
  const [failed, setFailed] = useState(false);
  const parent = useRef<HTMLDivElement>(null);
  const adapter = useRef<WorldSceneAdapter | undefined>(undefined);
  const shown = useRef(index);
  shown.current = index;
  const dayLength = useRef(dayLengthMs);
  dayLength.current = dayLengthMs;
  // The lowest live tier seen while this flashback is open: a live step down that removes the PiP
  // keeps it removed until the flashback closes, so a recovering live tier cannot recreate it.
  const [lowest, setLowest] = useState(tier);
  const held =
    tier === undefined || lowest === undefined || TIERS.indexOf(tier) < TIERS.indexOf(lowest)
      ? tier
      : lowest;
  if (held !== lowest) setLowest(held);
  const budget = held === undefined ? null : FLASHBACK_PIP_BUDGET[held];
  const hasBudget = budget !== null;

  useEffect(() => {
    if (!playing || index >= last) {
      if (playing && index >= last) setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setIndex(index + 1), FLASHBACK_FRAME_MS);
    return () => clearTimeout(timer);
  }, [playing, index, last]);

  useEffect(() => {
    const host = parent.current;
    if (!hasBudget || failed || !host) return;
    let active = true;
    let created: WorldSceneAdapter | undefined;
    const lose = () => {
      if (!active) return;
      created?.destroy();
      created = undefined;
      adapter.current = undefined;
      setFailed(true);
    };
    void import("./renderer.js")
      .then(({ ThreeWorldSceneAdapter }) => {
        if (!active) return;
        const renderer: WorldSceneAdapter = new ThreeWorldSceneAdapter(
          host,
          () => {
            if (!active || created !== renderer) return;
            try {
              renderer.setReducedMotion(true);
              renderer.setDayLength(dayLength.current);
              const first = frames[shown.current] ?? frames[0];
              if (first) renderer.loadSnapshot(first.projection);
              adapter.current = renderer;
            } catch {
              lose();
            }
          },
          lose,
          () => {},
          content,
          FLASHBACK_PIP_LIMITS,
        );
        created = renderer;
      })
      .catch(lose);
    return () => {
      active = false;
      adapter.current = undefined;
      created?.destroy();
    };
  }, [hasBudget, failed, content, frames]);

  useEffect(() => {
    adapter.current?.setDayLength(dayLengthMs);
  }, [dayLengthMs]);

  useEffect(() => {
    const frame = frames[index];
    if (!adapter.current || !frame) return;
    try {
      adapter.current.loadSnapshot(frame.projection);
    } catch {
      setFailed(true);
    }
  }, [index, frames]);

  if (frames.length === 0) return null;
  const frame = frames[index] ?? frames[0];
  if (!frame) return null;
  return (
    <section aria-label="Flashback replay" className="rw-flashback-replay">
      {budget && !failed ? (
        <div
          ref={parent}
          className="rw-flashback-pip"
          aria-hidden="true"
          style={{ width: budget.width, height: budget.height }}
          data-pip-tier={held}
        />
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
