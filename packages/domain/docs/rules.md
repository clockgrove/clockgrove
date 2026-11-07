# Rule primitives (RW-0110)

`validateRuleDefinition(value, catalog, path = "rule")` statically validates an unknown value against the
command catalog (`{type, version}[]`) and returns a deeply frozen, normalized `RuleDefinition`. It is pure and
total: every refusal throws `RuleValidationError`, a `DomainValidationError` subclass carrying `code` and
`path` (message `<path>: <message>`). `RULE_SCHEMA_VERSION` is `1`.

Top-level fields, exactly: `schemaVersion` (1), `id` (namespaced dotted identifier such as `pack.rule-one`),
`version` (positive safe integer), `trigger`, `bindings` (ordered `{name, expression}`, at most 32),
`condition` (boolean expression or `null`), `intents` (`{commandType, commandVersion, payload}`; `payload`
maps keys to expressions; 1..`maxFanout`; each `commandType@commandVersion` must be in the catalog) and
`budget`.

Trigger kinds and the variables each supplies (all kinds supply `at`, integer):

- `event` `{kind, eventType, eventVersion}`: no further variables; the payload is read with a `field` node.
- `schedule` `{kind, everyMs, offsetMs}` with `0n < everyMs <= 2^53` and `0n <= offsetMs < everyMs` (so
  `offsetMs <= 2^53` too; both inclusive upper bound 2^53): `occurrence` (integer).
- `threshold` `{kind, objectId | null, quantity, direction: "rising" | "falling", value: bigint}` with `value`
  from `-2^53` to `2^53` inclusive: `subject` (string) and `value` (integer).
- `geofence` `{kind, regionId, transition: "entered" | "left", objectId | null}`: `subject` (string).

Threshold `quantity` is the closed set `needs.hunger`, `needs.wetness`, `resource.quantity`.

Expressions are records with an `op` and an inferred type (integer = bigint, string, boolean): `literal`
`{type, value}`; `variable` `{name}` (a trigger variable or an earlier binding); `field` `{name, type}`
(event trigger only; declares the expected type); `add`, `sub`, `min`, `max` over integers giving integer;
`lt`, `le`, `gt`, `ge` over integers giving boolean; `eq`, `ne` over two operands of the same type giving
boolean; `and`, `or` `{left, right}` and `not` `{operand}` over booleans. An integer literal `value` must lie
from -2^53 to 2^53 inclusive. A binding's type is its
expression's type. Bindings may reference only trigger variables and earlier bindings.

`budget` is exactly `{maxFanout: 1..64, maxDepth: 1..8, cooldownMs: bigint, 0n <= cooldownMs <= 2^53}`
(inclusive upper bound 2^53). A rule has at most 256
expression nodes (bindings, condition and payload expressions together) and expressions nest at most 16
levels (a root is level 1).

Refusal paths: `null` or an array gives `rule`; a missing or extra field gives that field's path
(`rule.budget`, `rule.trigger.extra`); `rule.schemaVersion`, `rule.version`, `rule.trigger.kind`,
`rule.trigger.quantity`, `rule.budget.maxFanout|maxDepth|cooldownMs` name the offending value; a `cooldownMs`, `everyMs`, `offsetMs`
or threshold `value` beyond 2^53 is refused at its own path (`rule.budget.cooldownMs`,
`rule.trigger.everyMs|offsetMs|value`); an integer literal outside -2^53..2^53 is refused with code
`rule.range` at the literal's `.value` path (for example `rule.condition.right.value`,
`rule.intents[0].payload.x.value`, `rule.bindings[0].expression.value`); an expression
error names the offending node (for example `rule.condition.left` for a string operand of integer
arithmetic, or the variable node for an unknown or later binding); a non-boolean condition gives
`rule.condition`; empty or over-fanout intents give `rule.intents`; an uncatalogued command gives
`rule.intents[i].commandType`; exceeding the node or nesting bound names the first node past the bound.
