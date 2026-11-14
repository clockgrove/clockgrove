---
name: skill-curator
description: How to add, change or retire the agent skills of the clockgrove/clockgrove repository under .claude/skills/ and .agents/skills/. Use when a lesson from real work might belong in a skill, when editing or reviewing a skill, or when the two skill copies may have drifted. Not for actor-authored SKILL.md cognition inside worlds.
---

# Skill curator

Keep the repository's skills few, correct and in step with the docs.

## Pick the strongest home first

A lesson goes to the first destination that fits. Reason: a mechanism cannot be ignored, prose can.

1. **Check or config**: a `pnpm check` rule, dependency-cruiser rule or test that makes the mistake fail.
2. **Canonical doc**: if it changes what Clockgrove is, owns or guarantees, update the ADR, wave plan, protocol, runbook or package contract (see `AGENTS.md` Documentation map).
3. **Skill**: a repeatable procedure that spans tasks and is not already covered.
4. **Nothing**: the usual outcome. Interesting is not the same as reusable.

## Writing a skill

- Point to the repository's docs; do not restate them. Where a skill and a doc disagree, the doc wins: fix or cut the skill.
- Rule plus reason, short. Describe Clockgrove as it is now; no history.
- The repository is public: no credentials, internal hostnames, private repository links, personal details or unpublished plans.
- Prefer improving, merging or retiring an existing skill over adding one.

## Agent Skills standard

- One folder per skill holding `SKILL.md` and only the reference files it uses.
- Frontmatter `name` equals the folder name: lowercase letters, digits and hyphens, at most 64 characters.
- `description` is at most 1024 characters and says when to load the skill.
- Strict YAML: quote any value that contains `: `.
- `SKILL.md` stays under 500 lines; aim well under.

Validate before committing:

```
python3 -c 'import sys,yaml; t=open(sys.argv[1]).read().split("---")[1]; print(yaml.safe_load(t))' <path>/SKILL.md
```

## One copy, one link

Each skill lives once, in `.agents/skills/<name>/` (Codex reads it there). `.claude/skills/<name>` is a symlink to `../../.agents/skills/<name>` (Claude Code reads it there); Copilot reads either. Add the link with a new skill and remove it with a retired one, then confirm every link resolves:

```
for l in .claude/skills/*; do [ -e "$l/SKILL.md" ] || echo "broken: $l"; done
```

Reason: one copy can't drift. A Windows checkout needs git's `core.symlinks` for the link to work.

## Who changes skills

Skill changes are maintainer pull requests. An agent may draft a change from evidence, but a draft never governs its own review or an execution already running.
