#!/usr/bin/env python3
"""Validate Clockgrove ADR and wave-plan metadata blocks."""
from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

_METADATA_LINE_RE = re.compile(r"^\*\*(?P<key>[^*][^:]*):\*\*\s*(?P<value>.*?)\s*$")
_VERSION_RE = re.compile(r"^\d+(?:\.\d+)*$")
_WAVE_RE = re.compile(r"^\d+\b")

ADR_ALLOWED_STATUSES = frozenset({"Accepted", "Proposed", "Draft", "Superseded"})
WAVE_ALLOWED_STATUSES = frozenset(
    {
        "Current implementation specification",
        "Coding-agent implementation specification",
        "Optional future hosted-platform implementation specification",
        "Optional future commercial-hosting implementation specification",
        "Optional post-GA implementation specification",
    }
)

ADR_OPTIONAL_FIELDS = frozenset({"Version", "Scope", "Supersedes"})
WAVE_OPTIONAL_FIELDS = frozenset(
    {
        "Assumption",
        "Assumptions",
        "Decision source",
        "Development tooling",
        "Factory execution",
        "Filename note",
        "Visual reference",
    }
)


@dataclass(frozen=True)
class ParsedFrontmatter:
    title: str
    metadata: dict[str, str]


class ValidationError(ValueError):
    """Raised when a document's metadata block is invalid."""

    def __init__(self, errors: list[str]) -> None:
        self.errors = tuple(errors)
        super().__init__("\n".join(self.errors))


def parse_frontmatter(text: str) -> ParsedFrontmatter:
    """Parse a Clockgrove markdown title and metadata block."""
    lines = text.splitlines()
    index = 0
    while index < len(lines) and not lines[index].strip():
        index += 1
    if index >= len(lines):
        raise ValidationError(["document is empty"])

    title = lines[index].strip()
    if not title.startswith("# "):
        raise ValidationError(["document must begin with a level-1 heading"])
    index += 1

    while index < len(lines) and not lines[index].strip():
        index += 1

    metadata: dict[str, str] = {}
    errors: list[str] = []
    separator_found = False

    while index < len(lines):
        stripped = lines[index].strip()
        if stripped == "---":
            separator_found = True
            break
        if not stripped:
            index += 1
            continue
        match = _METADATA_LINE_RE.match(lines[index])
        if not match:
            errors.append(
                f"line {index + 1} must be a metadata line in the form '**Field:** value' or '---'"
            )
            index += 1
            continue
        key = match.group("key").strip()
        value = match.group("value").strip()
        if not value:
            errors.append(f"metadata field '{key}' must not be empty")
        elif key in metadata:
            errors.append(f"metadata field '{key}' must not be repeated")
        else:
            metadata[key] = value
        index += 1

    if not separator_found:
        errors.append("metadata block must be terminated by '---'")
    if errors:
        raise ValidationError(errors)
    return ParsedFrontmatter(title=title, metadata=metadata)


def validate_adr_frontmatter(text: str) -> ParsedFrontmatter:
    """Validate ADR metadata."""
    parsed = parse_frontmatter(text)
    errors = _validate_adr(parsed)
    if errors:
        raise ValidationError(errors)
    return parsed


def validate_wave_plan_frontmatter(text: str) -> ParsedFrontmatter:
    """Validate wave-plan metadata."""
    parsed = parse_frontmatter(text)
    errors = _validate_wave(parsed)
    if errors:
        raise ValidationError(errors)
    return parsed


def validate_adr_file(path: str | Path) -> ParsedFrontmatter:
    """Validate an ADR markdown file."""
    return validate_adr_frontmatter(Path(path).read_text(encoding="utf-8"))


def validate_wave_plan_file(path: str | Path) -> ParsedFrontmatter:
    """Validate a wave-plan markdown file."""
    return validate_wave_plan_frontmatter(Path(path).read_text(encoding="utf-8"))


def _validate_adr(parsed: ParsedFrontmatter) -> list[str]:
    metadata = parsed.metadata
    errors: list[str] = []

    if not (
        parsed.title.startswith("# ADR:")
        or parsed.title.startswith("# Clockgrove Architecture Decision:")
    ):
        errors.append(
            "ADR title must begin with '# ADR:' or '# Clockgrove Architecture Decision:'"
        )

    _require_status(metadata, ADR_ALLOWED_STATUSES, errors)
    _require_date(metadata, errors)

    authority_fields = [name for name in ("Applies to", "Accepted baseline") if name in metadata]
    if not authority_fields:
        errors.append("ADR metadata must include either 'Applies to' or 'Accepted baseline'")
    if "Applies to" in metadata:
        _validate_adr_applies_to(metadata["Applies to"], errors)
    if "Accepted baseline" in metadata:
        _validate_adr_accepted_baseline(metadata["Accepted baseline"], errors)

    _optional_version(metadata, errors)
    _reject_unknown_fields(
        metadata,
        required={"Status"},
        optional=ADR_OPTIONAL_FIELDS | {"Date", "Decision date", "Applies to", "Accepted baseline"},
        errors=errors,
    )
    return errors


def _validate_wave(parsed: ParsedFrontmatter) -> list[str]:
    metadata = parsed.metadata
    errors: list[str] = []

    if not parsed.title.startswith("# Clockgrove Wave "):
        errors.append("wave-plan title must begin with '# Clockgrove Wave '")

    _require_status(metadata, WAVE_ALLOWED_STATUSES, errors)
    _require_field(metadata, "Version", errors)
    _require_field(metadata, "Date", errors)
    _require_field(metadata, "Parent plan", errors)
    _require_field(metadata, "Product source", errors)
    _require_field(metadata, "Wave", errors)

    _optional_version(metadata, errors)
    _validate_date_value(metadata.get("Date"), "Date", errors)
    _validate_wave_authority(metadata, errors)

    wave_value = metadata.get("Wave")
    if wave_value and not _WAVE_RE.match(wave_value):
        errors.append("wave field must begin with a numeric wave identifier")

    _reject_unknown_fields(
        metadata,
        required={"Status", "Version", "Date", "Parent plan", "Product source", "Wave"},
        optional=WAVE_OPTIONAL_FIELDS,
        errors=errors,
    )
    return errors


def _require_status(metadata: dict[str, str], allowed: frozenset[str], errors: list[str]) -> None:
    value = metadata.get("Status")
    if not value:
        errors.append("metadata field 'Status' is required")
        return
    if value not in allowed:
        errors.append(f"status must be one of: {', '.join(sorted(allowed))}")


def _require_date(metadata: dict[str, str], errors: list[str]) -> None:
    if "Decision date" in metadata:
        _validate_date_value(metadata["Decision date"], "Decision date", errors)
        if "Date" in metadata:
            _validate_date_value(metadata["Date"], "Date", errors)
        return
    if "Date" in metadata:
        _validate_date_value(metadata["Date"], "Date", errors)
        return
    errors.append("metadata field 'Date' or 'Decision date' is required")


def _require_field(metadata: dict[str, str], field: str, errors: list[str]) -> None:
    if field not in metadata:
        errors.append(f"metadata field '{field}' is required")


def _validate_date_value(value: str | None, field: str, errors: list[str]) -> None:
    if not value:
        return
    try:
        datetime.strptime(value, "%B %d, %Y")
    except ValueError:
        errors.append(f"metadata field '{field}' must use 'Month DD, YYYY' format")


def _optional_version(metadata: dict[str, str], errors: list[str]) -> None:
    value = metadata.get("Version")
    if value and not _VERSION_RE.match(value):
        errors.append("metadata field 'Version' must use dotted numeric format")


def _validate_adr_applies_to(value: str, errors: list[str]) -> None:
    lowered = value.lower()
    if "prd" not in lowered:
        errors.append("ADR 'Applies to' must reference the PRD baseline")
    if "implementation plan" not in lowered and "wave" not in lowered:
        errors.append("ADR 'Applies to' must reference an implementation plan or wave authority")


def _validate_adr_accepted_baseline(value: str, errors: list[str]) -> None:
    lowered = value.lower()
    if "clockgrove-prd-v0.5.md" not in lowered:
        errors.append("ADR 'Accepted baseline' must reference 'clockgrove-prd-v0.5.md'")
    if "raccoon-world-cloudflare-implementation-plan.md" not in lowered:
        errors.append(
            "ADR 'Accepted baseline' must reference 'raccoon-world-cloudflare-implementation-plan.md'"
        )
    if "wave" not in lowered:
        errors.append("ADR 'Accepted baseline' must reference the applicable waves")


def _validate_wave_authority(metadata: dict[str, str], errors: list[str]) -> None:
    parent_plan = metadata.get("Parent plan")
    if parent_plan and "raccoon-world-cloudflare-implementation-plan.md" not in parent_plan:
        errors.append(
            "metadata field 'Parent plan' must reference 'raccoon-world-cloudflare-implementation-plan.md'"
        )

    product_source = metadata.get("Product source")
    if product_source and "clockgrove-prd-v0.5.md" not in product_source:
        errors.append("metadata field 'Product source' must reference 'clockgrove-prd-v0.5.md'")

    decision_source = metadata.get("Decision source")
    if decision_source and ("clockgrove-adr-" not in decision_source or ".md" not in decision_source):
        errors.append("metadata field 'Decision source' must reference a Clockgrove ADR markdown file")


def _reject_unknown_fields(
    metadata: dict[str, str], *, required: set[str], optional: set[str], errors: list[str]
) -> None:
    allowed = required | optional
    for key in metadata:
        if key not in allowed:
            errors.append(f"metadata field '{key}' is not recognized for this document type")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("document_type", choices=("adr", "wave"))
    parser.add_argument("paths", nargs="+")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    validator = validate_adr_file if args.document_type == "adr" else validate_wave_plan_file
    exit_code = 0

    for raw_path in args.paths:
        path = Path(raw_path)
        try:
            validator(path)
        except (OSError, ValidationError) as exc:
            print(f"{path}: invalid", file=sys.stderr)
            print(exc, file=sys.stderr)
            exit_code = 1
        else:
            print(f"{path}: valid")

    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
