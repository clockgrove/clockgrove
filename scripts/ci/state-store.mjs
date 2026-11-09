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
  async function request(method, key, { body, headers = {}, query } = {}) {
    const url = new URL(key ? `${base}/${backend.bucket}/${key}` : `${base}/${backend.bucket}`);
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
  return {
    bucket: backend.bucket,
    // The object's bytes, or null when it does not exist.
    async get(key) {
      const response = await request("GET", key);
      if (response.status === 404) return null;
      if (!response.ok) throw failed("read", key, response);
      return Buffer.from(await response.arrayBuffer());
    },
    // Writes only when no object holds the key, so nothing is ever overwritten.
    async create(key, body) {
      const response = await request("PUT", key, { body, headers: { "if-none-match": "*" } });
      if (response.status === 412) throw new Error(`state bucket object ${key} already exists`);
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

// OpenTofu's lock record (ID, Operation, Who, Version, Created), or null when no lock is held.
export async function readLock(store, target) {
  const body = await store.get(stateKeys(target).lock);
  if (body === null) return null;
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
  };
}

// One line naming the lock object, its holder and its age. Holds no state or plan content.
export function describeLock(target, store, lock, now = new Date()) {
  const created = Date.parse(lock.created);
  const age = Number.isNaN(created)
    ? "of unknown age"
    : `for ${Math.max(0, Math.round((now - created) / 60_000))} min (since ${lock.created})`;
  return `state lock ${store.bucket}/${stateKeys(target).lock} held by ${lock.who} (${lock.operation}) ${age}, lock ID ${lock.id || "unknown"}`;
}

// The deploy job's timeout. A younger lock may belong to a run that is still going.
export const liveLockMinutes = 45;

// Refuses with the holder's name and age when the environment's state is locked.
export async function assertUnlocked(store, target) {
  const lock = await readLock(store, target);
  assert(
    !lock,
    lock &&
      `${describeLock(target, store, lock)}; if no deploy or plan is running, the owner clears it with \`pnpm infra:state unlock ${target} <lock ID>\``,
  );
}

// A dated copy of the current state object, written beside it and never overwritten.
export async function backupState(store, target, label, now = new Date()) {
  const keys = stateKeys(target);
  const state = await store.get(keys.state);
  assert(state, `state object ${keys.state} missing after apply`);
  const key = `${keys.backups}${now.toISOString().replace(/[:.]/gu, "-")}-${label}.tfstate`;
  await store.create(key, state);
  return key;
}
