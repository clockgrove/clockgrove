// The R2 state bucket, read and written directly over the S3 API: the lock object's holder, dated
// backup copies of the state object, and the owner's unlock and restore. Requests are signed with
// AWS Signature Version 4, which R2 accepts with region `auto`. Dependency-free; credentials stay in
// memory and no response body is ever printed.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
// RFC 3986 unreserved characters stay as they are; everything else is percent-encoded.
const encode = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

// Signature Version 4 `Authorization` header for one request. `headers` must already hold `host`
// and `x-amz-date`; every header given is signed. The path is encoded once, as S3 requires.
export function signV4({ method, url, headers, payloadHash, credentials, region, service }) {
  const { pathname, searchParams } = new URL(url);
  const date = headers["x-amz-date"];
  const scope = `${date.slice(0, 8)}/${region}/${service}/aws4_request`;
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalQuery = [...searchParams]
    .map(([key, value]) => [encode(key), encode(value)])
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const canonical = [
    method,
    pathname
      .split("/")
      .map((segment) => encode(decodeURIComponent(segment)))
      .join("/"),
    canonicalQuery,
    ...names.map((name) => `${name}:${String(lower[name]).trim().replace(/\s+/gu, " ")}`),
    "",
    names.join(";"),
    payloadHash,
  ].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", date, scope, sha256(canonical)].join("\n");
  let key = `AWS4${credentials.secretAccessKey}`;
  for (const part of [date.slice(0, 8), region, service, "aws4_request"]) key = hmac(key, part);
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
}

// A client for one state bucket, from the generated S3 backend block and the R2 credentials.
export function stateStore(backend, credentials, fetcher = fetch) {
  assert(credentials.accessKeyId && credentials.secretAccessKey, "missing state credentials");
  const base = backend.endpoints.s3.replace(/\/$/u, "");
  const bucketPath = `${new URL(base).pathname.replace(/\/$/u, "")}/${backend.bucket}`;
  async function request(method, key, { body, headers = {}, query } = {}) {
    const url = new URL(key ? `${base}/${backend.bucket}/${key}` : `${base}/${backend.bucket}`);
    // URL parsing resolves `..` and `%2e` segments, turns `\` into `/` and drops tabs and
    // newlines, so a request goes out only when its path names exactly the bucket and key given.
    assert(
      decodedPath(url.pathname) === (key ? `${bucketPath}/${key}` : bucketPath),
      "state bucket key refused",
    );
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    const payloadHash = sha256(body ?? "");
    const signed = {
      ...headers,
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": new Date().toISOString().replace(/[-:]|\.\d{3}/gu, ""),
    };
    signed.authorization = signV4({
      method,
      url: url.toString(),
      headers: signed,
      payloadHash,
      credentials,
      region: backend.region,
      service: "s3",
    });
    delete signed.host;
    return fetcher(url, { method, headers: signed, body, signal: AbortSignal.timeout(30_000) });
  }
  const failed = (operation, key, response) =>
    new Error(`state bucket ${operation} of ${key} failed (HTTP ${response.status})`);
  // The object's bytes and ETag, or null when it does not exist.
  async function read(key) {
    const response = await request("GET", key);
    if (response.status === 404) return null;
    if (!response.ok) throw failed("read", key, response);
    return { body: Buffer.from(await response.arrayBuffer()), etag: response.headers.get("etag") };
  }
  return {
    bucket: backend.bucket,
    read,
    // The object's bytes, or null when it does not exist.
    async get(key) {
      return (await read(key))?.body ?? null;
    },
    // Writes only when no object holds the key, so nothing is ever overwritten.
    async create(key, body) {
      const response = await request("PUT", key, { body, headers: { "if-none-match": "*" } });
      if (response.status === 412) throw new Error(`state bucket object ${key} already exists`);
      if (!response.ok) throw failed("write", key, response);
    },
    // Overwrites only the exact object version that was read (its ETag), so a change made since
    // the read is never overwritten.
    async replace(key, body, etag) {
      assert(etag, `no ETag for ${key}`);
      const response = await request("PUT", key, { body, headers: { "if-match": etag } });
      if (response.status === 412 || response.status === 404)
        throw new Error(`state bucket object ${key} changed since it was read`);
      if (!response.ok) throw failed("write", key, response);
    },
    async delete(key) {
      const response = await request("DELETE", key);
      if (!response.ok && response.status !== 404) throw failed("delete", key, response);
    },
    async list(prefix) {
      const keys = [];
      let token;
      do {
        const response = await request("GET", undefined, {
          query: {
            "list-type": "2",
            prefix,
            ...(token ? { "continuation-token": token } : {}),
          },
        });
        if (!response.ok) throw failed("list", prefix, response);
        const xml = await response.text();
        for (const [, key] of xml.matchAll(/<Key>([^<]*)<\/Key>/gu)) keys.push(unescapeXml(key));
        token = /<IsTruncated>true<\/IsTruncated>/u.test(xml)
          ? unescapeXml(/<NextContinuationToken>([^<]*)</u.exec(xml)?.[1] ?? "")
          : undefined;
      } while (token);
      return keys.sort();
    },
  };
}
const decodedPath = (pathname) => {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
};
const unescapeXml = (value) =>
  value.replace(
    /&(lt|gt|quot|apos|amp);/gu,
    (_, name) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[name],
  );

// The bucket keys of one environment: its state object, OpenTofu's lock object beside it and the
// prefix of its dated backups.
export const stateKeys = (target) => ({
  state: `${target}/terraform.tfstate`,
  lock: `${target}/terraform.tfstate.tflock`,
  backups: `${target}/backups/`,
});

// A backup key: one plain file name directly under the environment's backups prefix, so no `..`,
// `%2e`, `/` or `\` can lead outside it.
export const isBackupKey = (target, key) =>
  typeof key === "string" &&
  key.startsWith(stateKeys(target).backups) &&
  /^[A-Za-z0-9][A-Za-z0-9._-]*\.tfstate$/u.test(key.slice(stateKeys(target).backups.length));

// OpenTofu's lock record (ID, Operation, Who, Version, Created) and the lock object's ETag, or null
// when no lock is held.
export async function readLock(store, target) {
  const object = await store.read(stateKeys(target).lock);
  if (object === null) return null;
  const { body, etag } = object;
  let info;
  try {
    info = JSON.parse(body.toString("utf8"));
  } catch {
    info = {};
  }
  return {
    id: typeof info.ID === "string" ? info.ID : "",
    operation: typeof info.Operation === "string" ? info.Operation : "unknown",
    who: typeof info.Who === "string" ? info.Who : "unknown",
    created: typeof info.Created === "string" ? info.Created : "",
    etag,
  };
}

// One line naming the lock object, its holder and its age. Holds no state or plan content. OpenTofu
// records the holder as user@hostname; only the user is named, since deploy logs are public.
export function describeLock(target, store, lock, now = new Date()) {
  const created = Date.parse(lock.created);
  const age = Number.isNaN(created)
    ? "of unknown age"
    : `for ${Math.max(0, Math.round((now - created) / 60_000))} min (since ${lock.created})`;
  return `state lock ${store.bucket}/${stateKeys(target).lock} held by ${lock.who.split("@")[0] || "unknown"} (${lock.operation}) ${age}, lock ID ${lock.id || "unknown"}`;
}

// The deploy job's 45-minute timeout plus 15 minutes for clock skew between the holder and the owner
// and for OpenTofu's shutdown after a cancel. A younger lock may belong to a run still going. The
// owner's own plans and cloud tests have no timeout, so age alone never proves a lock stale.
export const liveLockMinutes = 60;

// Dated backups kept per environment, five deploys of three stages each; older ones are deleted.
export const keptBackups = 15;

// Refuses with the holder's name and age when the environment's state is locked.
export async function assertUnlocked(store, target) {
  const lock = await readLock(store, target);
  assert(
    !lock,
    lock &&
      `${describeLock(target, store, lock)}; if no deploy, plan or cloud test is running, the owner clears it with \`pnpm infra:state unlock ${target} <lock ID>\``,
  );
}

// A dated copy of the current state object, written beside it and never overwritten.
export async function backupState(store, target, label, now = new Date()) {
  const keys = stateKeys(target);
  const state = await store.get(keys.state);
  assert(state, `state object ${keys.state} missing after apply`);
  return saveBackup(store, target, label, state, now);
}

// Writes one dated backup, then deletes all but the newest `keptBackups`, never the one just written
// or one in `keep`. Backup names start with their UTC time, so name order is age order.
export async function saveBackup(store, target, label, state, now = new Date(), keep = []) {
  const keys = stateKeys(target);
  const key = `${keys.backups}${now.toISOString().replace(/[:.]/gu, "-")}-${label}.tfstate`;
  await store.create(key, state);
  const backups = (await store.list(keys.backups)).filter((name) => isBackupKey(target, name));
  for (const old of backups.slice(0, -keptBackups))
    if (old !== key && !keep.includes(old)) await store.delete(old);
  return key;
}
