# Documentation frontmatter validator usage

## Purpose

`schemas/doc_validator.py` validates the metadata block at the top of Clockgrove ADR and wave-plan documents using only the Python standard library.

## Supported documents

### ADR frontmatter

Required fields:

- `Status`
- `Date` or `Decision date`
- `Applies to` or `Accepted baseline`

Optional fields currently recognized by the validator:

- `Version`
- `Scope`
- `Supersedes`

### Wave-plan frontmatter

Required fields:

- `Status`
- `Version`
- `Date`
- `Parent plan`
- `Product source`
- `Wave`

Optional fields currently recognized by the validator:

- `Assumption`
- `Assumptions`
- `Decision source`
- `Development tooling`
- `Factory execution`
- `Filename note`
- `Visual reference`

## Running the validator

Validate one or more ADRs:

```bash
python schemas/doc_validator.py adr \
  docs/adr/clockgrove-adr-management-plane-world-runtime-plane-and-shared-wallet.md
```

Validate one or more wave plans:

```bash
python schemas/doc_validator.py wave \
  docs/waves/clockgrove-wave-0-project-foundation-implementation-plan.md
```

Run the focused test coverage:

```bash
python -m unittest schemas.test_doc_validator
```

## Integration points

This helper is intentionally dependency-free so it can be integrated anywhere the repository already runs Python, including:

- local document checks before submitting documentation changes;
- targeted validation in future repository scripts that inspect ADR or wave metadata;
- CI or automation entry points added later, if the repository chooses to wire this helper into broader validation flows.
