from __future__ import annotations

import unittest
from pathlib import Path

from schemas.doc_validator import (
    ValidationError,
    validate_adr_file,
    validate_adr_frontmatter,
    validate_wave_plan_file,
    validate_wave_plan_frontmatter,
)


REPO_ROOT = Path(__file__).resolve().parent.parent


class DocValidatorTest(unittest.TestCase):
    def test_valid_existing_adr_is_accepted(self) -> None:
        path = REPO_ROOT / "docs/adr/clockgrove-adr-world-personas-and-object-mobility-policy.md"
        parsed = validate_adr_file(path)
        self.assertEqual(parsed.metadata["Status"], "Accepted")

    def test_valid_existing_wave_plan_is_accepted(self) -> None:
        path = REPO_ROOT / "docs/waves/clockgrove-wave-0-project-foundation-implementation-plan.md"
        parsed = validate_wave_plan_file(path)
        self.assertTrue(parsed.title.startswith("# Clockgrove Wave 0:"))

    def test_living_yard_pilot_matches_approved_protocol(self) -> None:
        path = REPO_ROOT / "docs/waves/clockgrove-wave-4-visual-projection-web-client-implementation-plan.md"
        parsed = validate_wave_plan_file(path)
        self.assertEqual(parsed.title, "# Clockgrove Wave 4: Shared Visual Projection and Inspector Web Client")
        checkpoint = path.read_text(encoding="utf-8").split(
            "### 1.1 Objectives, sequencing, and checkpoints\n\n", 1
        )[1].split("\n---\n", 1)[0]
        protocol = checkpoint.split(
            "#### Living-yard pilot protocol — predeclared, unevaluated\n\n", 1
        )[1].strip()
        # Independent expectations from Objective issue 781's approved pilot, not document metadata.
        self.assertEqual(
            protocol,
            """**Approval:** the maintainer approved this protocol on 2026-10-21.

**Status:** Evaluated on 2026-11-01 by the agent observer, on candidate `32e9976983f0` (main when issue 800 was accepted), starting at canonical revision 0. The rubric below holds the results; the protocol above is unchanged.

**Audience and recording:** the maintainer is the sole audience. No recording is permitted.

Amended (2026-11-01): the observer is Claude Code, the agent the maintainer orchestrates, not the maintainer. It uses the checkpoint's visual or text path through a local browser, under the same tasks and rubric. No recording is kept beyond the rubric results. An agent observer measures whether the checkpoint's surfaces let an observer complete the tasks; it is not a reading of human comprehension.

**Hypothesis:** An observer can distinguish canonical time from derived current time, recognize a rain-related change in an action, and explain that action using selection and recorded Why evidence.

**Tasks:** Ask the observer to use the authorized living-yard checkpoint, with its visual or equivalent accessible text path:

1. Identify canonical time and derived current time, and explain the distinction.
2. Identify a rain-related change in an action and describe what changed.
3. Select the entity involved, inspect its recent actions and recorded Why evidence, and use that evidence to explain the rain-related action.

**Rubric:** For each task, record whether it was completed unaided and which misunderstandings occurred. Results:

| Task | Unaided completion | Misunderstandings |
| --- | --- | --- |
| Distinguish canonical time from derived current time | Yes | Time is a bare integer with no unit or clock. Derived time appears only after selecting an entity and is labelled \"Earned simulation time\", which is not explained. After time advanced, derived and canonical values were identical, so the distinction disappeared. \"hunger remainder\" was unclear. |
| Recognize a rain-related action change | Yes, with dead ends | The scene shows only current \"Rain intensity\" (0 when looked at), with no rain visual or history, so rain was found only through Why. Recent-action rows named \"Action action-pilot-advance-N\" are events labelled by the clock command. `routine.selected` rows are buried among needs and wellbeing rows and needed paging. \"Selected action\" shows no previous value. One raccoon's rain-0 shelter-seeking (a tie at score 0) was a false lead. |
| Explain the action using selection and recorded Why evidence | Yes | One Why lists every raccoon's decision, and the same Why button repeats on every event row of a command. Feature names and scores have no units or legend. A later weather command listed as a \"child command\" of an earlier decision read as reversed causality. |

**Interpretation:** This pilot makes no population-level claim.

**Run notes:** The text path carried the run, because the canvas drew all entity labels on top of each other. The observer UI has no time control, so simulated time was advanced with `world.advance` commands from outside it (about 2.25 simulated days). One `world.weather.set` rain command was also issued; it proved redundant, since the seed had already rained and the explained decision predates it. Bringing up the checkpoint needed a temporary harness because there is no local start command. The findings above map to planned Wave 4 Objectives: time and boot display, the yard's labels and rain visual, the interaction card, canvas-free timeline and live changes, and per-entity, labelled Why evidence.

**Cost envelope** (recorded 2026-11-01 for issue 817; Claude Code, delegated by the maintainer): local only. No hosted infrastructure and no Clockgrove model-provider spend; the only model use is the observing agent's own session. One session of about 30 minutes on the local checkpoint.

**Replay conditions** (recorded 2026-11-01 for issue 817; Claude Code, delegated by the maintainer): the session starts from the deterministic `green-lake-yard@1` seed. It records the candidate commit and the canonical world revision at its start. The pilot runs once. A replay from the same commit and revision is allowed only to clarify an observed misunderstanding, never to re-score a task.

**Qualification carry-forward:** The Wave 3 evidence manifest (`pnpm qualify:wave3`, issue 853) keeps its hosted items pending: real Cloudflare qualification, owned by issue 881, and the deploy of main, owned by issue 693. This checkpoint uses the incremental-delivery ADR's local-development readiness exception; local acceptance does not qualify Wave 3 or Wave 4. The pending hosted obligations and the full wave-exit evidence remain required. The pilot was evaluated on 2026-11-01; its results are above.""",
        )

    def test_missing_required_field_is_rejected(self) -> None:
        document = """# Clockgrove Wave 99: Example

**Status:** Coding-agent implementation specification
**Version:** 1.0
**Date:** August 18, 2026
**Parent plan:** `raccoon-world-cloudflare-implementation-plan.md` v3.8
**Wave:** 99 of 13

---
"""
        with self.assertRaises(ValidationError) as context:
            validate_wave_plan_frontmatter(document)
        self.assertIn("metadata field 'Product source' is required", context.exception.errors)

    def test_invalid_status_and_authority_are_rejected(self) -> None:
        document = """# ADR: Invalid Example

**Status:** Current
**Date:** August 18, 2026
**Accepted baseline:** `other-prd.md` v1.0; `other-plan.md` v2.0

---
"""
        with self.assertRaises(ValidationError) as context:
            validate_adr_frontmatter(document)
        self.assertIn("status must be one of: Accepted, Draft, Proposed, Superseded", context.exception.errors)
        self.assertIn(
            "ADR 'Accepted baseline' must reference 'clockgrove-prd-v0.5.md'",
            context.exception.errors,
        )
        self.assertIn(
            "ADR 'Accepted baseline' must reference 'raccoon-world-cloudflare-implementation-plan.md'",
            context.exception.errors,
        )


if __name__ == "__main__":
    unittest.main()
