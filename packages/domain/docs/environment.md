# Environment policy and state (RW-0107a)

`WorldBehaviorPolicy.environment` is an optional, versioned record (`EnvironmentPolicy`,
`schemaVersion: 1`): `dayLengthMs`, 1 to 64 `phases` (`{name, startMs, lightBand}`, first start 0,
strictly increasing starts below the day length, unique names), 1 to 64 `weatherSegments`
(`{durationMs, rainIntensity, temperatureBand}`, repeating as a cycle) and `wetThreshold` and
`discomfortThreshold` (basis points 1 to 10000). Both cycles are anchored at simulation time 0 and
all names are pack data. `WorldState.environment` (`EnvironmentState`: `phase`, `lightBand`,
`nextPhaseBoundary`, `segmentIndex`, `temperatureBand`, `nextWeatherBoundary`) is present exactly when
the policy has one. Absent fields leave the canonical encoding and hash of policies and states
unchanged, and `decodeWorldScenario` accepts both as optional.

`validateEnvironmentPolicy` and `validateEnvironmentState` throw `EnvironmentValidationError` (a
`DomainValidationError` whose `path` is `policy.environment...` or `state.environment...`);
`deriveEnvironmentState(policy, time)` returns the record the policy implies and
`environmentDisagreement(policy, state)` names the first differing path. Three events at version 1
are reduced by `reduceWorldEvent`: `environment.phase-changed` and `weather.transitioned` update the
record (the latter also sets `weather.rainIntensity`) and must occur at the record's boundary;
`exposure.threshold-crossed` changes no physical field. The kernel owns the systems that emit them.
