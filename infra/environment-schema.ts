import { z } from "zod";
import { assertNoSecretValues } from "../scripts/check-secrets.mjs";

export const environments = ["local", "ci", "development", "staging", "production"] as const;
const safe = z
  .string()
  .min(1)
  .max(128)
  .superRefine((value, context) => {
    try {
      assertNoSecretValues(value);
    } catch {
      context.addIssue({ code: "custom", message: "secret-shaped value" });
    }
  });
const name = safe.pipe(z.string().regex(/^[a-z][a-z0-9-]{1,62}$/));
const domain = safe.pipe(z.string().regex(/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/));
const queue = z.strictObject({ name, deadLetter: name });
export const environmentSchema = z
  .strictObject({
    environment: z.enum(environments),
    resources: z.strictObject({
      worker: name,
      queues: z.strictObject({
        worldReactions: queue,
        cognitiveIndexing: queue,
        externalEffects: queue,
      }),
      buckets: z.strictObject({ artifacts: name, assets: name, backups: name }),
      hyperdrive: name,
      // Workers Analytics Engine dataset; Wrangler binds it and the first write creates it.
      analytics: name,
      aiGateway: name,
      serviceToken: name,
      turnstile: name,
      database: z.strictObject({
        project: name,
        branch: name,
        database: name,
        roles: z.strictObject({
          migrations: z.literal("clockgrove_migrator"),
          runtime: z.literal("clockgrove_runtime"),
          support: z.literal("clockgrove_support"),
          backup: z.literal("clockgrove_backup"),
          authentication: z.literal("clockgrove_auth_verifier"),
          management: z.literal("clockgrove_management_reader"),
          worldAuthorization: z.literal("clockgrove_world_reader"),
        }),
        region: z.enum(["aws-us-west-2"]),
      }),
    }),
    authentication: z.strictObject({
      origin: safe.pipe(z.url({ protocol: /^https$/ })),
      providerEnvironment: z.enum(environments),
      transport: z.literal("direct-postgresql"),
    }),
    domains: z.strictObject({ runtime: domain, dnsTarget: domain }),
    // Public account and zone identifiers are routing metadata, never credentials.
    safeIds: z.strictObject({
      cloudflareAccountId: z.string().regex(/^[a-f0-9]{32}$/),
      cloudflareZoneId: z.string().regex(/^[a-f0-9]{32}$/),
    }),
    retention: z.strictObject({
      queueSeconds: z.number().int().min(60).max(1209600),
      databaseSeconds: z.number().int().min(0).max(2592000),
      artifactDays: z.number().int().min(1).max(3650),
    }),
    budgets: z.strictObject({
      modelMonthlyUsd: z.number().nonnegative().max(10000),
      requestsPerMinute: z.number().int().min(1).max(10000),
      databaseMinCu: z.number().min(0.25).max(16),
      databaseMaxCu: z.number().min(0.25).max(16),
    }),
    compatibilityDate: z.iso.date(),
    modelAliases: z.strictObject({
      default: z.enum(["fixture", "interactive-standard"]),
      background: z.enum(["fixture", "background-standard"]),
    }),
  })
  .superRefine((manifest, context) => {
    if (
      manifest.authentication.providerEnvironment !== manifest.environment ||
      manifest.authentication.origin !== `https://${manifest.domains.runtime}`
    )
      context.addIssue({ code: "custom", message: "authentication origin/environment mismatch" });
    const names = Object.values(manifest.resources.queues).flatMap((queue) => [
      queue.name,
      queue.deadLetter,
    ]);
    if (new Set(names).size !== names.length)
      context.addIssue({ code: "custom", message: "queues must be distinct" });
    if (manifest.budgets.databaseMinCu > manifest.budgets.databaseMaxCu)
      context.addIssue({ code: "custom", message: "invalid database compute budget" });
    const checkNames = (value: unknown): void => {
      if (
        typeof value === "string" &&
        !value.startsWith(`rw-${manifest.environment}-`) &&
        value !== "aws-us-west-2" &&
        !value.startsWith("clockgrove_")
      )
        context.addIssue({
          code: "custom",
          message: "resource must use canonical environment prefix",
        });
      else if (typeof value === "object" && value !== null)
        Object.values(value).forEach(checkNames);
    };
    checkNames(manifest.resources);
  });
export type EnvironmentManifest = z.infer<typeof environmentSchema>;

export const secretSchema = z.strictObject({
  environment: z.enum(environments),
  secrets: z
    .array(
      z.strictObject({
        name: z.enum([
          "CLOUDFLARE_API_TOKEN",
          "NEON_API_KEY",
          "DATABASE_URL",
          "MIGRATION_DATABASE_URL",
          "SUPPORT_DATABASE_URL",
          "BACKUP_DATABASE_URL",
          "BETTER_AUTH_SECRET",
          "AUTH_DATABASE_URL",
          "MANAGEMENT_DATABASE_URL",
          "WORLD_AUTHORIZATION_DATABASE_URL",
          "MODEL_PROVIDER_API_KEY",
          "TURNSTILE_SECRET_KEY",
          "CF_ACCESS_CLIENT_SECRET",
          "SENTRY_OTLP_TOKEN",
          "ARTIFACT_KEYRING",
        ]),
        consumer: z.enum([
          "opentofu/cloudflare",
          "opentofu/neon",
          "hyperdrive/runtime-role",
          "database/migrations",
          "database/support",
          "database/backup-verification",
          "runtime/authentication",
          "runtime/session-verification",
          "runtime/management-readers",
          "runtime/world-authorization",
          "ai-gateway/provider",
          "runtime/turnstile",
          "operations/access",
          "observability/sentry",
          "runtime/artifact-encryption",
        ]),
      }),
    )
    .superRefine((secrets, context) => {
      if (new Set(secrets.map(({ name }) => name)).size !== secrets.length)
        context.addIssue({ code: "custom", message: "duplicate secret" });
    }),
});
export type SecretDeclaration = z.infer<typeof secretSchema>;
