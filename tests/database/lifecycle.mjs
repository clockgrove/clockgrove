import assertStrict from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertSupportedPgvectorVersion,
  databaseTransport,
  psqlQuery,
  withDisposableDatabase,
} from "../../scripts/database/lib.mjs";

export async function testDisposableDatabaseLifecycle() {
  for (const source of ["available pgvector extension", "installed pgvector extension"]) {
    assertSupportedPgvectorVersion("0.8.7", source);
    for (const version of ["0.8.1", "0.8.6", "0.8.8", ""]) {
      assertStrict.throws(() => assertSupportedPgvectorVersion(version, source), /0\.8\.7/u);
    }
  }
  assert(databaseTransport({}) === "socket", "socket is not the default transport");
  assert(
    databaseTransport({ FACTORY_LOCAL: "1" }) === "loopback",
    "Factory local mode not loopback",
  );
  assert(
    databaseTransport({ FACTORY_LOCAL: "1", CLOCKGROVE_TEST_DB_TRANSPORT: "socket" }) === "socket",
    "the explicit transport did not win",
  );
  assertStrict.throws(
    () => databaseTransport({ CLOCKGROVE_TEST_DB_TRANSPORT: "tcp" }),
    /CLOCKGROVE_TEST_DB_TRANSPORT/u,
  );
  const transport = databaseTransport();
  const originalTmpdir = process.env.TMPDIR;
  // The supplied temporary root, not a fixed /tmp: sandboxes may provide only TMPDIR.
  const temporaryBase = tmpdir();
  const longTmpdirOwner = await mkdtemp(path.join(temporaryBase, "clockgrove-long-tmpdir-"));
  const longTmpdir = path.join(longTmpdirOwner, "x".repeat(140));
  await mkdir(longTmpdir);

  const resources = [];
  try {
    process.env.TMPDIR = temporaryBase;
    await probeLifecycle(resources);
    await assertRemoved(resources[0].temporaryRoot);

    process.env.TMPDIR = longTmpdir;
    const expectedFailure = new Error("deliberate lifecycle cleanup probe");
    let observedFailure;
    try {
      await probeLifecycle(resources, expectedFailure);
    } catch (error) {
      observedFailure = error;
    }
    assert(
      observedFailure === expectedFailure,
      "long-TMPDIR lifecycle did not preserve operation failure",
    );
    await assertRemoved(resources[1].temporaryRoot);

    assert(
      resources[0].temporaryRoot !== resources[1].temporaryRoot,
      "database clusters were reused",
    );
    assert(
      resources[1].temporaryRoot.startsWith(`${longTmpdir}${path.sep}`) &&
        Buffer.byteLength(resources[1].temporaryRoot) >= 108,
      "long-TMPDIR cluster did not exercise a path longer than the Unix-socket limit",
    );
    assert(
      resources[0].port !== resources[1].port ||
        resources[0].socketDirectory !== resources[1].socketDirectory,
      "database endpoints were reused",
    );
    for (const resource of resources) {
      assert(resource.transport === transport, "fixture used another transport");
      if (transport === "loopback") {
        assert(
          resource.socketDirectory === undefined && resource.host === "127.0.0.1",
          "loopback database exposed a Unix socket or a non-loopback host",
        );
        assert(resource.password, "loopback database had no per-run password");
        continue;
      }
      assert(
        resource.socketDirectory.startsWith("@clockgrove-"),
        "database socket was not abstract",
      );
      assert(
        Buffer.byteLength(`${resource.socketDirectory}/.s.PGSQL.${resource.port}`) < 108,
        "database socket exceeded the Linux Unix-socket limit",
      );
    }
  } finally {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    await rm(longTmpdirOwner, { recursive: true, force: true });
  }
}

async function probeLifecycle(resources, failure) {
  await withDisposableDatabase(async (fixture) => {
    const { environment, socketDirectory, temporaryRoot, tools, transport } = fixture;
    const result = await psqlQuery(
      tools,
      environment,
      "SELECT current_database(), current_setting('server_version')",
    );
    assert(
      result.trim().startsWith("clockgrove|18.6"),
      `unexpected PostgreSQL probe: ${result.trim()}`,
    );
    resources.push({
      port: environment.PGPORT,
      host: environment.PGHOST,
      password: environment.PGPASSWORD !== undefined,
      transport,
      socketDirectory,
      temporaryRoot,
    });
    if (failure !== undefined) throw failure;
  });
}

async function assertRemoved(target) {
  try {
    await access(target, constants.F_OK);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`disposable database resource was not removed: ${target}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
