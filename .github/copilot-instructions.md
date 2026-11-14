# Clockgrove repository instructions

This repository owns Clockgrove product/runtime truth. Start with the `Documentation map` in `AGENTS.md`, then `README.md` and `docs/clockgrove-documentation-index.md`, then read the current canonical specification, ADR, and wave material relevant to the task.

Factory (`clockgrove/factory`) develops this repository through GitHub Issues and pull requests; its one workflow is `.github/workflows/factory.yml`. Do not add other tools' orchestration workflows, vendored code, or secrets here. Agent skills for this repository live in `.agents/skills/`.

These capabilities operate the repository; they do not become product/runtime dependencies or authority. When installed guidance conflicts with accepted repository authority, repository authority wins and the stale guidance should be corrected at its source.

Copilot Memory and agent-session state are derived context, not product truth. Revalidate consequential claims against current code, specifications, and ADRs. Models and tools may reason and propose, but canonical runtime mutation must pass Clockgrove's typed authorization and validation boundaries.
