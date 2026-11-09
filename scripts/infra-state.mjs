// `pnpm infra:state <command> <environment> [argument]`: the owner's tools for a hosted
// environment's OpenTofu state in its R2 bucket. Needs INFRA_STATE_BUCKET, INFRA_STATE_ACCESS_KEY_ID
// and INFRA_STATE_SECRET_ACCESS_KEY in the shell. Prints keys, lock holders and ages, never state.
//
//   lock <environment>              who holds the state lock, and for how long
//   unlock <environment> <lock ID>  clear a stale lock; refuses a younger lock or another ID
//   backups <environment>           the dated state backups, oldest first
//   restore <environment> <key>     copy a backup to the state object; refuses if one exists
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stateStoreFor } from "./ci/deployment-authority.mjs";
import { root } from "./ci/evidence.mjs";
import { assertRoutingMetadata } from "./ci/routing-metadata.mjs";
import { describeLock, liveLockMinutes, readLock, stateKeys } from "./ci/state-store.mjs";

const usage = "infra:state lock|unlock|backups|restore <development|staging> [lock ID|backup key]";

// Clears the lock only when it is the one the owner named and is older than any live run.
export async function unlock(store, target, id, now = new Date()) {
  const lock = await readLock(store, target);
  assert(lock, `${target} state is not locked`);
  const description = describeLock(target, store, lock, now);
  assert(lock.id && lock.id === id, `${description}; the given lock ID does not match`);
  const created = Date.parse(lock.created);
  assert(
    !Number.isNaN(created) && now - created >= liveLockMinutes * 60_000,
    `${description}; a lock younger than ${liveLockMinutes} min may belong to a running deploy or plan`,
  );
  await store.delete(stateKeys(target).lock);
  return `cleared ${description}`;
}

// Restores into an environment whose state object is gone, never over one.
export async function restore(store, target, key) {
  const keys = stateKeys(target);
  assert(key?.startsWith(keys.backups), `restore takes a key under ${keys.backups}`);
  assert(!(await readLock(store, target)), `${target} state is locked`);
  const backup = await store.get(key);
  assert(backup, `no backup ${key}`);
  await store.create(keys.state, backup);
  return `restored ${store.bucket}/${keys.state} from ${key}`;
}

export async function main([command, target, argument], env = process.env, now = new Date()) {
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
      return restore(store, target, argument);
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
