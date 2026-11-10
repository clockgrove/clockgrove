import { createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { backfillWorldProcessDeadlines } from "./world-process-backfill.mjs";

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

// PGDG's Debian/Ubuntu packages install the server tools here, off PATH, behind /usr/bin wrappers.
const debianPostgresBindir = "/usr/lib/postgresql/18/bin";

export async function discoverPostgresTools() {
  const pathDirectories = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  let fallback;
  // A tool missing from PATH comes from `pg_config --bindir`, or from the Debian directory when
  // pg_config is not on PATH either. The version check below still holds every tool to 18.6.
  const fallbackBindir = () =>
    (fallback ??= findExecutable("pg_config", pathDirectories).then(async (pgConfig) =>
      pgConfig
        ? {
            directory: (await capture(pgConfig, ["--bindir"])).trim(),
            source: `${pgConfig} --bindir`,
          }
        : { directory: debianPostgresBindir, source: "the Debian default; no pg_config on PATH" },
    ));
  const locate = async (tool) => {
    const onPath = await findExecutable(tool, pathDirectories);
    if (onPath) return onPath;
    const { directory, source } = await fallbackBindir();
    const found = path.isAbsolute(directory) && (await findExecutable(tool, [directory]));
    if (!found) throw new Error(`${tool} was not found on PATH or in ${directory} (${source})`);
    return found;
  };
  const tools = Object.fromEntries(
    await Promise.all(requiredTools.map(async (tool) => [tool, await locate(tool)])),
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
 * `settings` adds server settings as `name=value` strings, such as preloaded libraries.
 */
export async function withDisposableDatabase(
  operation,
  { deadlineMs = 5 * 60_000, maxConnections, settings = [] } = {},
) {
  return await withSubprocessDeadline(
    () => createDisposableDatabase(operation, maxConnections, settings),
    deadlineMs,
  );
}

/**
 * How clients reach the disposable cluster. `socket`: a Linux abstract Unix socket with trust
 * authentication and no TCP listener. `loopback`: a `127.0.0.1` TCP listener with no Unix socket and
 * SCRAM authentication by a per-run password, for sandboxes that refuse every `AF_UNIX` socket.
 * A non-empty `CLOCKGROVE_TEST_DB_TRANSPORT` wins; otherwise Factory's local mode
 * (`FACTORY_LOCAL=1`) selects `loopback`; otherwise `socket`.
 */
export function databaseTransport(environment = process.env) {
  const explicit = environment.CLOCKGROVE_TEST_DB_TRANSPORT;
  if (explicit === "socket" || explicit === "loopback") return explicit;
  if (explicit !== undefined && explicit !== "")
    throw new Error(
      `CLOCKGROVE_TEST_DB_TRANSPORT must be "socket" or "loopback"; found ${JSON.stringify(explicit)}`,
    );
  return environment.FACTORY_LOCAL === "1" ? "loopback" : "socket";
}

async function createDisposableDatabase(operation, maxConnections, settings) {
  const transport = databaseTransport();
  const tools = await discoverPostgresTools();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "clockgrove-postgres-"));
  const dataDirectory = path.join(temporaryRoot, "data");
  const socketDirectory =
    transport === "socket" ? `@clockgrove-${process.pid}-${randomUUID()}` : undefined;
  // Loopback TCP is reachable by every local process on a shared host, so it is never trusted.
  const password = transport === "loopback" ? randomBytes(32).toString("hex") : undefined;
  const logPath = path.join(temporaryRoot, "postgres.log");
  const port = await availablePort();
  let startAttempted = false;
  try {
    if (password === undefined) {
      await run(tools.initdb, [
        "--pgdata",
        dataDirectory,
        "--username=clockgrove_admin",
        "--auth-local=trust",
        "--auth-host=reject",
        "--encoding=UTF8",
        "--no-locale",
      ]);
    } else {
      // The owner-private (mkdtemp, 0700) root holds the password file only for initdb.
      const passwordFile = path.join(temporaryRoot, "admin-password");
      await writeFile(passwordFile, `${password}\n`, { mode: 0o600, flag: "wx" });
      try {
        await run(tools.initdb, [
          "--pgdata",
          dataDirectory,
          "--username=clockgrove_admin",
          `--pwfile=${passwordFile}`,
          "--auth-local=reject",
          "--auth-host=scram-sha-256",
          "--encoding=UTF8",
          "--no-locale",
        ]);
      } finally {
        await rm(passwordFile, { force: true });
      }
    }
    const serverOptions = [
      "-F",
      "-c",
      socketDirectory === undefined ? "listen_addresses=127.0.0.1" : "listen_addresses=",
      "-c",
      // Empty in loopback mode: any socket directory makes PostgreSQL create an AF_UNIX socket.
      `unix_socket_directories=${socketDirectory ?? ""}`,
      "-p",
      String(port),
      ...(maxConnections === undefined ? [] : ["-c", `max_connections=${maxConnections}`]),
      ...settings.flatMap((setting) => ["-c", setting]),
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
    // An inherited PGPASSWORD never reaches the fixture: its presence marks loopback mode.
    const { PGPASSWORD: _inherited, ...inheritedEnvironment } = process.env;
    const environment = {
      ...inheritedEnvironment,
      PGDATABASE: "postgres",
      PGHOST: socketDirectory ?? "127.0.0.1",
      PGPORT: String(port),
      PGUSER: "clockgrove_admin",
      // Every login role shares the run's password, so role switches through PGUSER still connect.
      ...(password === undefined ? {} : { PGPASSWORD: password }),
    };
    await bootstrapRolesAndDatabase(tools, environment, password);
    let active = true;
    try {
      await operation({
        tools,
        environment: { ...environment, PGDATABASE: "clockgrove" },
        temporaryRoot,
        transport,
        socketDirectory,
        withLoopbackTransport: (callback, bridgeConnections) => {
          if (!active) throw new Error("disposable fixture is no longer active");
          // PostgreSQL already listens on loopback TCP itself; no bridge is needed.
          if (socketDirectory === undefined) return callback(port);
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

async function bootstrapRolesAndDatabase(tools, environment, password) {
  const loginRoles = [
    "clockgrove_runtime",
    "clockgrove_support",
    "clockgrove_backup",
    "clockgrove_auth_verifier",
    "clockgrove_management_reader",
    "clockgrove_world_reader",
  ];
  // Only a SCRAM verifier enters SQL, so no statement, error or log carries the password.
  const passwords = [];
  if (password !== undefined)
    for (const role of loginRoles)
      passwords.push(`ALTER ROLE ${role} PASSWORD ${literal(scramVerifier(password))};`);
  await psql(
    tools,
    environment,
    `CREATE ROLE clockgrove_migrator
       NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
     CREATE ROLE clockgrove_mcp_secrets
       NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
     CREATE ROLE clockgrove_runtime
       LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
     CREATE ROLE clockgrove_support LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
     CREATE ROLE clockgrove_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
     CREATE ROLE clockgrove_auth_verifier LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
     CREATE ROLE clockgrove_management_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
     CREATE ROLE clockgrove_world_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
     GRANT clockgrove_migrator TO clockgrove_admin;
     ${passwords.join("\n")}`,
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
    if (existing !== "" && existing !== checksum)
      throw new Error(`migration checksum changed after application: ${name}`);
    if (existing === "")
      await psql(
        tools,
        environment,
        `SET ROLE clockgrove_migrator;
       ${sql}
       INSERT INTO clockgrove.schema_migrations (migration_name, checksum)
       VALUES (${literal(name)}, ${literal(checksum)});`,
        ["--single-transaction"],
      );
    if (
      name === "0048_world_process_deadlines.sql" &&
      checksum ===
        createHash("sha256")
          .update(await readFile(path.join(repositoryRoot, "db/migrations", name), "utf8"))
          .digest("hex")
    ) {
      await backfillWorldProcessDeadlines(tools, environment, options.backfillOptions);
    }
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
  const { viaStdin = false, ...execution } = options;
  return capture(
    tools.psql,
    [
      "--no-psqlrc",
      "--set=ON_ERROR_STOP=1",
      "--tuples-only",
      "--no-align",
      ...(viaStdin ? ["--file", "-"] : ["--command", sql]),
    ],
    { ...execution, environment, ...(viaStdin ? { input: sql } : {}) },
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

// PostgreSQL's stored SCRAM-SHA-256 form (RFC 5802, RFC 7677); a hex password needs no SASLprep.
function scramVerifier(password) {
  const iterations = 4096;
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest("base64");
  const serverKey = createHmac("sha256", salted).update("Server Key").digest("base64");
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey}:${serverKey}`;
}

function literal(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function shellWord(value) {
  if (/^[A-Za-z0-9_./=:-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function findExecutable(name, directories) {
  for (const directory of directories) {
    const candidate = path.join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue with the next directory.
    }
  }
  return undefined;
}

export function assertSupportedPgvectorVersion(version, source) {
  if (!supportedPgvectorVersions.has(version)) {
    throw new Error(
      `${source} must be exactly one of ${[...supportedPgvectorVersions].join(", ")}; found ${version || "none"}`,
    );
  }
}
