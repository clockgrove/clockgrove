# Contributing to Clockgrove

Clockgrove is licensed under the [MIT License](LICENSE). Contributions are accepted under the MIT License: by opening a pull request you agree that your contribution is licensed under it, and you confirm that you have the right to license it so.

## Before you start

- Set up a checkout with the [contributor bootstrap](README.md#contributor-bootstrap).
- Read [AGENTS.md](AGENTS.md) for the repository rules. They apply to human and agent contributors alike.
- Use the canonical commands and their rules in [docs/runbooks/development.md](docs/runbooks/development.md), and the test rules in [docs/runbooks/testing.md](docs/runbooks/testing.md).
- Keep within the [clean-room and publication boundary](README.md#clean-room-and-publication-boundary). Code, data or assets that are not original Clockgrove work need an entry in [provenance.json](provenance.json) with their source, license and reason; third-party npm dependencies are covered by the SBOM it names instead.

## Issues

Search the existing issues first, then file one with the matching form. The [delivery record rules](AGENTS.md#delivery-record) govern issue metadata:

- Each issue has a native issue type: `Feature` for a product capability, `Task` for maintenance, investigation or qualification, `Bug` for a standalone defect. Labels never classify the issue.
- Each open issue has exactly one priority label: `P0`, `P1` or `P2`.
- An Objective is a role, not a type. The `factory:objective` label is only for new product work from a wave plan, and maintainers apply it. Leftover wave gaps, regressions, maintenance, plan amendments, re-qualification and cleanup are plain `Bug`, `Task` or `Feature` issues, done directly.

## Pull requests

- Reference the issue the pull request resolves, for example `Fixes issue 123`, and keep the pull request to that one outcome.
- Answer the six questions of [the design checklist](docs/runbooks/design-checklist.md) in the description, with `file:line` evidence.
- Run `pnpm format`, then `pnpm check`, `pnpm test` and `pnpm run verify:docs`, plus any other command the runbooks require for the area you changed. Report the commands you ran and their results.
- Never include credentials, secrets, personal data or private source in an issue, a pull request or a commit.

## Security

Report a suspected vulnerability privately, as [SECURITY.md](SECURITY.md) describes, never in a public issue or pull request.
