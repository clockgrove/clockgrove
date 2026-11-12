import { useState } from "react";
import type { SceneSession } from "../scene-api.js";
import { EffectApprovals } from "./effect-approvals.js";

export function OperatorEffects({ session }: { readonly session: SceneSession }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Operator approvals</summary>
      {open && <EffectApprovals session={session} operator />}
    </details>
  );
}
