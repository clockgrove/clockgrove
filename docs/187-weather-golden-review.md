# Issue 187 part 3: weather event registry golden review

Reviewed the conformance-generated `.actual.json` bundles using the [golden review workflow](../packages/simulator/docs/conformance.md#golden-review-workflow). This part adds `resource.weather-integrated@1` to the kernel event and reducer registries. Each existing registry entry remains equivalent; each registry gains exactly that one entry. Only `kernel.events`, `kernel.reducers`, and the derived `bundleHash` differ. No scenario events, physical state, assertions, material hashes, pack artifacts or equivalence results change.

These fixtures do not yet declare weather water holders. Their scheduled sources remain for the later process/source migration part; this review does not approve that migration. The asset visual golden is unchanged.

| Scenario | Golden file | Reviewed change |
| --- | --- | --- |
| neutral-conformance | [worlds/fixture/goldens/neutral-conformance.json](../worlds/fixture/goldens/neutral-conformance.json) | Add weather event/reducer identity; recompute bundle hash; all physical outputs unchanged. |
| birth-and-parentage | [worlds/fixture/reference/goldens/birth-and-parentage.json](../worlds/fixture/reference/goldens/birth-and-parentage.json) | Add weather event/reducer identity; recompute bundle hash; all physical outputs unchanged. |
| boundary-walk | [worlds/fixture/reference/goldens/boundary-walk.json](../worlds/fixture/reference/goldens/boundary-walk.json) | Add weather event/reducer identity; recompute bundle hash; all physical outputs unchanged. |
| cedar-growth | [worlds/fixture/reference/goldens/cedar-growth.json](../worlds/fixture/reference/goldens/cedar-growth.json) | Add weather event/reducer identity; recompute bundle hash; all physical outputs unchanged. |
| death-and-successor | [worlds/fixture/reference/goldens/death-and-successor.json](../worlds/fixture/reference/goldens/death-and-successor.json) | Add weather event/reducer identity; recompute bundle hash; all physical outputs unchanged. |
| differential-perception | [worlds/fixture/reference/goldens/differential-perception.json](../worlds/fixture/reference/goldens/differential-perception.json) | Add weather event/reducer identity; recompute bundle hash; all physical outputs unchanged. |
| favorite-snack-house | [worlds/fixture/reference/goldens/favorite-snack-house.json](../worlds/fixture/reference/goldens/favorite-snack-house.json) | Add weather event/reducer identity; recompute bundle hash; all physical outputs unchanged. |
| fence-gap-portal | [worlds/fixture/reference/goldens/fence-gap-portal.json](../worlds/fixture/reference/goldens/fence-gap-portal.json) | Add weather event/reducer identity; recompute bundle hash; all physical outputs unchanged. |
| food-decay-and-conservation | [worlds/fixture/reference/goldens/food-decay-and-conservation.json](../worlds/fixture/reference/goldens/food-decay-and-conservation.json) | Add weather event/reducer identity; recompute bundle hash; all physical outputs unchanged. |
| months-fast-forward | [worlds/fixture/reference/goldens/months-fast-forward.json](../worlds/fixture/reference/goldens/months-fast-forward.json) | Add weather event/reducer identity; recompute bundle hash; all physical outputs unchanged. |
| rain-shelter-comfort | [worlds/fixture/reference/goldens/rain-shelter-comfort.json](../worlds/fixture/reference/goldens/rain-shelter-comfort.json) | Add weather event/reducer identity; recompute bundle hash; all physical outputs unchanged. |
| social-learning | [worlds/fixture/reference/goldens/social-learning.json](../worlds/fixture/reference/goldens/social-learning.json) | Add weather event/reducer identity; recompute bundle hash; all physical outputs unchanged. |
| street-dwell | [worlds/fixture/reference/goldens/street-dwell.json](../worlds/fixture/reference/goldens/street-dwell.json) | Add weather event/reducer identity; recompute bundle hash; all physical outputs unchanged. |
| walk-crossings | [worlds/fixture/reference/goldens/walk-crossings.json](../worlds/fixture/reference/goldens/walk-crossings.json) | Add weather event/reducer identity; recompute bundle hash; all physical outputs unchanged. |
| walk-out-of-den | [worlds/fixture/reference/goldens/walk-out-of-den.json](../worlds/fixture/reference/goldens/walk-out-of-den.json) | Add weather event/reducer identity; recompute bundle hash; all physical outputs unchanged. |

The focused conformance suite must pass after copying the exact reviewed bytes; Node executes all reference scenarios and Node/workerd parity covers the neutral fixture. Full reference workerd and long-run qualification remain in their existing CI lanes.

Rebase review on default branch `ce9c973`: retained the default branch’s updated movement and shelter outputs for boundary-walk and walk-crossings, and its new walk-out-of-den scenario. Compared each conformance-generated actual bundle to that default-branch golden: the only changes are the weather event/reducer entries and derived bundle hash. Accepted the exact reviewed bytes. This expands the registry review to 15 scenario bundles.
