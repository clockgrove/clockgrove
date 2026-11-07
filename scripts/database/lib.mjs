import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ownedSubprocess,
  withoutSubprocessCancellation,
  withSubprocessDeadline,
} from "../lib/subprocess.mjs";

import { assertContractSteps } from "./contract-steps.mjs";
import { withOwnedPostgresWireBridge } from "./native-transport.mjs";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const requiredTools = [
  "initdb",
  "pg_ctl",
  "postgres",
  "psql",
  "pg_config",
  "pg_dump",
  "pg_restore",
];
const supportedPostgresVersion = "18.6";
const supportedPgvectorVersions = new Set(["0.8.7"]);

export async function discoverPostgresTools() {
  const tools = Object.fromEntries(
    await Promise.all(requiredTools.map(async (tool) => [tool, await findOnPath(tool)])),
  );
  for (const tool of requiredTools) {
    const version = await capture(tools[tool], ["--version"]);
    if (
      !new RegExp(
        `(?:^PostgreSQL |\\(PostgreSQL\\) )${supportedPostgresVersion.replace(".", "\\.")}(?:\\s|$)`,
        "u",
      ).test(version.trim())
    ) {
      throw new Error(
        `PostgreSQL ${supportedPostgresVersion} is required; ${tool} reported: ${version.trim()}`,
      );
    }
  }
  return tools;
}

/**
 * `deadlineMs` bounds the cluster's commands; long runs pass a wider bound than the default.
 * `maxConnections` replaces PostgreSQL's default of 100 (the load curves need more).
 */
export async function withDisposableDatabase(
  operation,
  { deadlineMs = 5 * 60_000, maxConnections } = {},
) {
  return await withSubprocessDeadline(
    () => createDisposableDatabase(operation, maxConnections),
    deadlineMs,
  );
}

async function createDisposableDatabase(operation, maxConnections) {
  const tools = await discoverPostgresTools();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "clockgrove-postgres-"));
  const dataDirectory = path.join(temporaryRoot, "data");
  const socketDirectory = `@clockgrove-${process.pid}-${randomUUID()}`;
  const logPath = path.join(temporaryRoot, "postgres.log");
  const port = await availablePort();
  let startAttempted = false;
  try {
    await run(tools.initdb, [
      "--pgdata",
      dataDirectory,
      "--username=clockgrove_admin",
      "--auth-local=trust",
      "--auth-host=reject",
      "--encoding=UTF8",
      "--no-locale",
    ]);
    const serverOptions = [
      "-F",
      "-c",
      "listen_addresses=",
      "-c",
      `unix_socket_directories=${socketDirectory}`,
      "-p",
      String(port),
      ...(maxConnections === undefined ? [] : ["-c", `max_connections=${maxConnections}`]),
    ]
      .map(shellWord)
      .join(" ");
    try {
      startAttempted = true;
      await run(tools.pg_ctl, [
        "--pgdata",
        dataDirectory,
        "--log",
        logPath,
        "--options",
        serverOptions,
        "--wait",
        "start",
      ]);
    } catch (error) {
      const serverLog = await readFile(logPath, "utf8").catch(() => "PostgreSQL wrote no log");
      throw new Error(`${error.message}\n${serverLog}`);
    }
    const environment = {
      ...process.env,
      PGDATABASE: "postgres",
      PGHOST: socketDirectory,
      PGPORT: String(port),
      PGUSER: "clockgrove_admin",
    };
    await bootstrapRolesAndDatabase(tools, environment);
    let active = true;
    try {
      await operation({
        tools,
        environment: { ...environment, PGDATABASE: "clockgrove" },
        temporaryRoot,
        socketDirectory,
        withLoopbackTransport: (callback, bridgeConnections) => {
          if (!active) throw new Error("disposable fixture is no longer active");
          return withOwnedPostgresWireBridge(
            `\0${socketDirectory.slice(1)}/.s.PGSQL.${port}`,
            callback,
            bridgeConnections,
          );
        },
      });
    } finally {
      active = false;
    }
  } finally {
    // pg_ctl can time out after creating a live postmaster. Inspect our owned directory
    // on every attempted start, including failure, before deciding it can be removed.
    if (
      startAttempted &&
      (await access(path.join(dataDirectory, "postmaster.pid")).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      ))
    ) {
      await withoutSubprocessCancellation(() =>
        run(
          tools.pg_ctl,
          ["--pgdata", dataDirectory, "--mode=immediate", "--wait", "--timeout=10", "stop"],
          { timeoutMs: 12_000 },
        ),
      );
    }
    // A failed stop preserves the directory and its ownership evidence for diagnosis.
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function bootstrapRolesAndDatabase(tools, environment) {
  await psql(
    tools,
    environment,
    `CREATE ROLE clockgrove_migrator
       NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
     CREATE ROLE clockgrove_runtime
       LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
     CREATE ROLE clockgrove_support LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
     CREATE ROLE clockgrove_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
     CREATE ROLE clockgrove_auth_verifier LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
     CREATE ROLE clockgrove_management_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
     CREATE ROLE clockgrove_world_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
     GRANT clockgrove_migrator TO clockgrove_admin;`,
  );
  await psql(
    tools,
    environment,
    "CREATE DATABASE clockgrove OWNER clockgrove_migrator TEMPLATE template0 ENCODING 'UTF8';",
  );
}

export async function applyMigrations(tools, environment, options = {}) {
  const migrationDirectory =
    options.migrationDirectory ?? path.join(repositoryRoot, "db/migrations");
  const migrations = (await readdir(migrationDirectory))
    .filter((name) => /^\d+.*\.sql$/u.test(name))
    .sort();
  if (migrations.length === 0) throw new Error("no database migrations were found");
  await assertContractSteps(migrationDirectory, migrations);
  const availableVersion = (
    await psqlQuery(
      tools,
      environment,
      "SELECT default_version FROM pg_available_extensions WHERE name = 'vector'",
    )
  ).trim();
  assertSupportedPgvectorVersion(availableVersion, "available pgvector extension");
  await psql(tools, environment, "CREATE EXTENSION IF NOT EXISTS vector;");
  await verifyPgvectorVersion(tools, environment);
  await psql(
    tools,
    environment,
    `SET ROLE clockgrove_migrator;
     CREATE SCHEMA IF NOT EXISTS clockgrove AUTHORIZATION clockgrove_migrator;
     CREATE TABLE IF NOT EXISTS clockgrove.schema_migrations (
       migration_name text PRIMARY KEY,
       checksum text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT statement_timestamp()
     );`,
  );

  for (const name of migrations) {
    const sql = await readFile(path.join(migrationDirectory, name), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const existing = (
      await psqlQuery(
        tools,
        environment,
        `SELECT checksum FROM clockgrove.schema_migrations WHERE migration_name = ${literal(name)}`,
      )
    ).trim();
    if (existing === checksum) continue;
    if (existing !== "") throw new Error(`migration checksum changed after application: ${name}`);
    await psql(
      tools,
      environment,
      `SET ROLE clockgrove_migrator;
       ${sql}
       INSERT INTO clockgrove.schema_migrations (migration_name, checksum)
       VALUES (${literal(name)}, ${literal(checksum)});`,
      ["--single-transaction"],
    );
  }
}

export async function verifyPgvectorVersion(tools, environment) {
  const installedVersion = (
    await psqlQuery(
      tools,
      environment,
      "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
    )
  ).trim();
  assertSupportedPgvectorVersion(installedVersion, "installed pgvector extension");
}

export async function applySqlFile(tools, environment, relativePath) {
  const sql = await readFile(path.join(repositoryRoot, relativePath), "utf8");
  await psql(tools, environment, sql, ["--single-transaction"]);
}

export async function psql(tools, environment, sql, extraArguments = []) {
  await run(tools.psql, ["--no-psqlrc", "--set=ON_ERROR_STOP=1", ...extraArguments, "--file=-"], {
    environment,
    input: sql,
  });
}

export async function psqlQuery(tools, environment, sql, options = {}) {
  return capture(
    tools.psql,
    ["--no-psqlrc", "--set=ON_ERROR_STOP=1", "--tuples-only", "--no-align", "--command", sql],
    { ...options, environment },
  );
}

export async function run(executable, arguments_, options = {}) {
  const result = await ownedSubprocess(executable, arguments_, {
    ...options,
    env: options.environment ?? process.env,
    inherit: true,
  });
  assertCommandResult(executable, result);
}

async function capture(executable, arguments_, options = {}) {
  const result = await ownedSubprocess(executable, arguments_, {
    ...options,
    env: options.environment ?? process.env,
  });
  assertCommandResult(executable, result);
  return result.stdout;
}

function assertCommandResult(executable, result) {
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${executable} exited with ${result.status ?? result.signal}: ${result.stderr.trim()}`,
    );
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a local PostgreSQL port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function literal(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function shellWord(value) {
  if (/^[A-Za-z0-9_./=:-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function findOnPath(name) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (directory === "") continue;
    const candidate = path.join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  throw new Error(`${name} was not found on PATH`);
}

export function assertSupportedPgvectorVersion(version, source) {
  if (!supportedPgvectorVersions.has(version)) {
    throw new Error(
      `${source} must be exactly one of ${[...supportedPgvectorVersions].join(", ")}; found ${version || "none"}`,
    );
  }
}
