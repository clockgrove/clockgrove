import { expect, it } from "vitest";
import { ContractDecodeError, decodeUsageWebhookRequest } from "../src/index.js";

const scope = { tenantId: "tenant-1", worldId: "world-1", timelineId: "main", spaceId: "space-1" };
const decode = (url: unknown) => decodeUsageWebhookRequest({ version: 1, ...scope, url });

it("stores a webhook URL in its normalised https form and refuses one that is not a public https host", () => {
  expect(decode("https://hooks.example/usage").url).toBe("https://hooks.example/usage");
  expect(decode(null).url).toBeNull();
  // Every spelling `new URL` reads as https is stored as the one form the column accepts.
  for (const spelling of ["HTTPS://Hooks.Example", "https:hooks.example", " https://hooks.example"])
    expect(decode(spelling).url).toBe("https://hooks.example/");
  for (const refused of [
    "http://hooks.example/usage",
    "https://user:pass@hooks.example/usage",
    "https://127.0.0.1/usage",
    "https://0x7f.1/usage",
    "https://[::1]/usage",
    "https://localhost/usage",
    "https://metadata/usage",
    "https://db.internal/usage",
    "https://router.local/usage",
    `https://hooks.example/${"a".repeat(2048)}`,
    "not a url",
  ])
    expect(() => decode(refused), refused).toThrow(ContractDecodeError);
});
