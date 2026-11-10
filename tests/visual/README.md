# Wave 4 visual goldens

[`golden-states.journey.browser.test.mjs`](golden-states.journey.browser.test.mjs) owns one
capture traversal for the fixture world and external worlds. Its fixed matrix is 1536×864,
1280×720 and 390×844 on WebGPU and forced WebGL2, with reduced motion for still captures:

- daylight/dry;
- dusk/rain at low, medium and high quality, plus the existing dusk/rain reference state;
- night/rain at low, medium and high quality;
- selected actor rail;
- event/Why inspector;
- selected inspectable object rail;
- disconnected/recovering;
- text access.

Daylight is 12:00, dusk 17:45 and 19:00, and night 22:00 on the HUD's 24-hour face, which scales
the world's environment day length; a world needs an environment policy for its clock. The
fixture caller also retains its renderer qualification assertions. External worlds use their
own pack, shell, static assets and optional runtime presentation; they need not reproduce fixture
lanterns, puddles or atlas content. Capture success does not establish whole-wave qualification.

A capture's hash depends only on the Clockgrove commit and the world. The shell renders each
wall-clock value, such as an action's recorded-at time, in a `[data-wall-clock]` element, and every
capture paints those as solid magenta boxes; the shell itself still shows the real time. A box is
as wide as its text in tabular numerals, so it is the same width on every run only while the value
keeps one length, as the shell's millisecond UTC timestamps do. A state framed on one region, such
as the event/Why inspector, places that region on a whole pixel, so content above it whose height
depends on timing cannot shift its text. The disconnected/recovering state holds the page clock
from before the socket drops until the shot, and waits on the shell's `data-scene-status`; the
shell's reconnect, which reports `connecting` and clears the scene, cannot run first.

## Fixture caller

After installing the pinned browser and native-runtime toolchain, run from Clockgrove:

```sh
env CI=true pnpm test:visual
```

The existing qualification caller supplies `CLOCKGROVE_WAVE4_EVIDENCE` and retains visual output
under its `visual/` directory. Without it, the suite creates a temporary evidence directory.
Fixture approvals remain in [`approved-captures.json`](approved-captures.json).

## External caller

Install a separate exact-commit platform checkout with frozen dependencies and provision its
PostgreSQL, pgvector and browser toolchain as described in the
[pinned-checkout guide](../../packages/simulator/docs/conformance.md#external-visual-goldens).
The world needs no npm project. From its repository:

```sh
node ../clockgrove/scripts/capture-world.mjs \
  --pack worlds/sample --shell worlds/sample/shell.json \
  --assets assets/reviewed --out tests/visual
```

Paths are relative to the caller, or absolute. Use `--actor <id>` and `--object <id>` to choose
specific projected entities; the default selection uses suitable entities from that world.
The actor must have recorded Why evidence. Optional `runtime.json` beside the pack is read by
the native runtime. Reviewed static assets must already be hydrated. The suite never copies the
world into Clockgrove.

Output contains the named PNG captures and `captures.json` with SHA-256 hashes; forced WebGL2
captures live under `webgl2/`. `approval-status.json` records the digest review status. Approval belongs to `approved-captures.json` in the same output
directory. A successful command prints its progress and a final
`{"status":"ok","reports":[...]}`. Exit 0 means the capture run completed, not that review
approved it. Exit 1 denotes a capture validation failure, 2 invalid arguments or input locations,
and 70 an unexpected internal error; failure diagnostics go to stderr.

SIGINT, SIGTERM or SIGHUP asks the run to stop: the suite tears down its runtime, browser and
PostgreSQL cluster as after a failure, and the command exits 128 plus the signal number. A run
that has not stopped 60 seconds later, or a second signal, ends the suite by force; the command
then stops every process and cluster the run started and removes its temporary directory. A run
past its 540-second bound is stopped the same way and exits 1.

## Review and approval

Inspect each PNG at its declared viewport and backend. A person approves it in a reviewed world
repository change. An agent may approve only on the owner's explicit delegation, recorded in
that change. Neither the capture command nor CI may approve an image.

Use the same approval format as the fixture, with paths relative to the visual output directory:

```json
{
  "approvals": [
    {
      "file": "daylight-dry@1536x864.png",
      "sha256": "sha256:<the exact capture digest>"
    },
    {
      "file": "webgl2/daylight-dry@1536x864.png",
      "sha256": "sha256:<the exact WebGL2 capture digest>"
    }
  ]
}
```

Copy the reviewed file's exact digest from the report. A matching file and digest is approved;
an absent approval or changed digest remains pending until reviewed again. Capturing overwrites
the named captures and reports, never the approval decisions. Commit the captures, hashes and
reviewed approvals in the world repository. Keep changes to the pinned Clockgrove commit explicit:
upgrading the platform can change the resulting captures and require renewed review.
