# Model gateway

`@clockgrove/model-gateway` is the one path from Clockgrove cognition to a language model. Callers
name an alias, such as `stevie.conversation`. The alias pins the provider routes, bounds, timeouts
and fallback. The gateway reserves budget and checks breakers before any prompt is sent, validates
structured output, and returns every provider failure as an explicit, recoverable outcome. It never
throws one, so a model outage degrades cognition and the world keeps running.

## Usage

Import from `@clockgrove/model-gateway`; the package entry is `src/index.ts`.

- `createModelGateway` builds a `ModelGateway` from aliases, adapters, a budget port and an
  accounting sink.
- `ModelGateway.stream` streams text deltas, `generateObject` returns Zod-validated data, and
  `inspect` reports each route's breaker.
- `PRODUCTION_ALIASES` holds the production alias. Its first route is Vercel AI Gateway and its
  fallback is Anthropic directly, both serving the same model.
- `AiSdkRouteAdapter` serves both production providers through the Vercel AI SDK, which is the only
  code that imports provider SDKs.
- `ScriptedModelProvider` is the deterministic provider for tests, CI and evals.

## Tests

- `pnpm test` runs the offline suite in `test/model-gateway.journey.test.ts`. It needs no key and no
  network: a local HTTP server stands in for the provider.
- `CLOCKGROVE_MODEL_LIVE=1 pnpm --filter @clockgrove/model-gateway test:live` sends one bounded
  request through the real production alias and prints its accounting record. It needs
  `AI_GATEWAY_API_KEY` or `ANTHROPIC_API_KEY` in the environment, and skips without one. CI never
  sets `CLOCKGROVE_MODEL_LIVE`.

## Subsystem contracts

- [Model gateway](docs/model-gateway.md): aliases, routes, outcomes, timeouts, breakers, budget,
  accounting and credentials (RW-0504).
