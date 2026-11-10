// `pnpm infra:state <command> <environment> [argument]`: the owner's tools for a hosted
// environment's OpenTofu state in its R2 bucket. Needs INFRA_STATE_BUCKET, INFRA_STATE_ACCESS_KEY_ID
// and INFRA_STATE_SECRET_ACCESS_KEY in the shell. Prints keys, lock holders and ages, never state.
//
//   lock <environment>                       who holds the state lock, and for how long
//   unlock <environment> <lock ID>           clear a stale lock; refuses a younger lock or another ID
//   backups <environment>                    the dated state backups, oldest first
//   restore <environment> <key> [--replace]  copy a backup to the state object; refuses over an
//                                            existing one unless --replace, which backs it up first
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { restoresRetiredRoles, stateStoreFor } from "./ci/deployment-authority.mjs";
import { root } from "./ci/evidence.mjs";
import { assertRoutingMetadata } from "./ci/routing-metadata.mjs";
import {
  describeLock,
  isBackupKey,
  liveLockMinutes,
  readLock,
  saveBackup,
  stateKeys,
} from "./ci/state-store.mjs";

const usage =
  "infra:state lock|unlock|backups|restore <development|staging> [lock ID|backup key [--replace]]";

// An OpenTofu lock record held by this tool, so a deploy or plan started meanwhile refuses as it
// would for any held lock. Names the local user only, never the host.
const lockRecord = (store, target, operation, now) => ({
  ID: randomUUID(),
  Operation: `infra:state ${operation}`,
  Info: "",
  Who: userInfo().username,
  Version: "",
  Created: now.toISOString(),
  Path: `${store.bucket}/${stateKeys(target).state}`,
});

// Deletes the lock only while it is still the record this tool wrote.
async function release(store, target, record) {
  const lock = await readLock(store, target);
  if (lock?.id === record.ID) await store.delete(stateKeys(target).lock);
}

// Clears the lock only when it is the one the owner named and is older than any live run. The
// checked lock is first replaced by this tool's own record, conditional on its ETag, so a lock that
// changed after the check (cleared, then taken by a new run) is never the one deleted.
export async function unlock(store, target, id, now = new Date()) {
  const lock = await readLock(store, target);
  assert(lock, `${target} state is not locked`);
  const description = describeLock(target, store, lock, now);
  assert(lock.id && lock.id === id, `${description}; the given lock ID does not match`);
  const created = Date.parse(lock.created);
  assert(
    !Number.isNaN(created) && now - created >= liveLockMinutes * 60_000,
    `${description}; a lock younger than ${liveLockMinutes} min may belong to a running deploy, plan or cloud test`,
  );
  const record = lockRecord(store, target, "unlock", now);
  await store.replace(stateKeys(target).lock, JSON.stringify(record), lock.etag);
  await release(store, target, record);
  return `cleared ${description}`;
}

// Restores a backup into the environment's state object while holding the state lock. Over an
// existing object only with --replace, which first saves that object as a backup and then writes
// only if it is still the version saved.
export async function restore(store, target, key, { replace = false } = {}, now = new Date()) {
  const keys = stateKeys(target);
  assert(isBackupKey(target, key), `restore takes a backup key ${keys.backups}<name>.tfstate`);
  const backup = await store.get(key);
  assert(backup, `no backup ${key}`);
  const record = lockRecord(store, target, "restore", now);
  try {
    await store.create(keys.lock, JSON.stringify(record));
  } catch (error) {
    const lock = await readLock(store, target);
    assert(!lock, lock && `${describeLock(target, store, lock, now)}; nothing restored`);
    throw error;
  }
  try {
    const current = await store.read(keys.state);
    // Over a present or a lost state alike, refuse a backup from before the SQL-created roles.
    const others = await Promise.all(
      (await store.list(keys.backups))
        .filter((name) => name !== key && isBackupKey(target, name))
        .map((name) => store.get(name)),
    );
    assert(
      !restoresRetiredRoles([current?.body, ...others].filter(Boolean), backup),
      `${key} predates the SQL-created database roles and holds their retired Neon API roles; a deploy from it would delete the live roles (see docs/runbooks/infrastructure.md, Database roles)`,
    );
    if (!current) {
      await store.create(keys.state, backup);
      return `restored ${store.bucket}/${keys.state} from ${key}`;
    }
    assert(
      replace,
      `${store.bucket}/${keys.state} exists; rerun with --replace to back it up and replace it`,
    );
    const saved = await saveBackup(store, target, "replaced", current.body, now, [key]);
    await store.replace(keys.state, backup, current.etag);
    return `replaced ${store.bucket}/${keys.state} with ${key}; the replaced object is ${saved}`;
  } finally {
    await release(store, target, record);
  }
}

export async function main([command, target, argument, flag], env = process.env, now = new Date()) {
  assert(["development", "staging"].includes(target), usage);
  const config = JSON.parse(
    await readFile(path.join(root, `infra/environments/${target}.json`), "utf8"),
  );
  assertRoutingMetadata(config, target);
  const store = stateStoreFor(target, config, env);
  switch (command) {
    case "lock": {
      const lock = await readLock(store, target);
      return lock ? describeLock(target, store, lock, now) : `${target} state is not locked`;
    }
    case "unlock":
      return unlock(store, target, argument, now);
    case "backups": {
      const keys = await store.list(stateKeys(target).backups);
      return keys.length ? keys.join("\n") : `${target} has no state backups`;
    }
    case "restore":
      assert(flag === undefined || flag === "--replace", usage);
      return restore(store, target, argument, { replace: flag === "--replace" }, now);
    default:
      throw new assert.AssertionError({ message: usage });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(await main(process.argv.slice(2)));
  } catch (error) {
    console.error(
      `infra:state: ${error instanceof assert.AssertionError ? error.message.split("\n")[0] : error.message}`,
    );
    process.exitCode = 1;
  }
}
