-- Artifact store (RW-0207, #667). Artifact metadata can only describe bytes that match it, private
-- classes are stored only as AES-256-GCM ciphertext, and the runtime role cannot rewrite either.
-- No producer has written artifact_references before this migration, so the new NOT NULL columns
-- need no backfill; the migration fails on a leftover row.

-- One data key per (tenant, world, private class, version), wrapped by a versioned KEK that never
-- reaches PostgreSQL. A principal whose ceiling lacks the class cannot read the wrapped key. The
-- runtime role may append keys and rewrap them (kek_id, wrapped_key), never delete them: crypto-shred
-- is Wave 9.
CREATE TABLE clockgrove.artifact_data_keys (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  privacy_class text NOT NULL CONSTRAINT artifact_data_keys_private_class
    CHECK (privacy_class IN ('private_cognition', 'conversation', 'operator_evidence')),
  key_version integer NOT NULL CONSTRAINT artifact_data_keys_key_version CHECK (key_version >= 1),
  kek_id text NOT NULL CONSTRAINT artifact_data_keys_kek_id CHECK (kek_id ~ '^[a-z0-9-]{1,64}$'),
  -- Stored form: 0x01 || nonce(12) || ciphertext(32) || tag(16).
  wrapped_key bytea NOT NULL CONSTRAINT artifact_data_keys_wrapped_key
    CHECK (octet_length(wrapped_key) = 61),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, world_id, privacy_class, key_version),
  FOREIGN KEY (tenant_id, world_id) REFERENCES clockgrove.worlds (tenant_id, world_id)
);

ALTER TABLE clockgrove.artifact_data_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.artifact_data_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_privacy_isolation ON clockgrove.artifact_data_keys
  USING (clockgrove.runtime_can_access(tenant_id, privacy_class))
  WITH CHECK (clockgrove.runtime_can_access(tenant_id, privacy_class));

-- Exactly one location: inline bytes (at most 128 KiB) or a content-addressed spill key
-- `<retention>/<tenant hex>/sha256/<hex>`, where the tenant segment is the lowercase hex of the UTF-8
-- tenant ID, so a row can only name an object of its own tenant. content_hash is the SHA-256 of the stored bytes, which for a
-- private class is the ciphertext envelope; no plaintext hash is stored.
ALTER TABLE clockgrove.artifact_references
  ALTER COLUMN storage_key DROP NOT NULL,
  ADD COLUMN inline_content bytea,
  ADD COLUMN retention_class text NOT NULL CONSTRAINT artifact_references_retention_class
    CHECK (retention_class IN ('durable', 'ephemeral')),
  ADD COLUMN encryption text NOT NULL CONSTRAINT artifact_references_encryption
    CHECK (encryption IN ('none', 'aes-256-gcm-v1')),
  ADD COLUMN data_key_version integer,
  ADD CONSTRAINT artifact_references_content_hash
    CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT artifact_references_one_location
    CHECK ((inline_content IS NULL) <> (storage_key IS NULL)),
  ADD CONSTRAINT artifact_references_inline_bytes CHECK (
    inline_content IS NULL OR (
      octet_length(inline_content) = byte_length
      AND byte_length <= 131072
      AND content_hash = 'sha256:' || encode(sha256(inline_content), 'hex')
    )
  ),
  ADD CONSTRAINT artifact_references_storage_key CHECK (
    storage_key IS NULL
    OR storage_key = retention_class || '/' || encode(convert_to(tenant_id, 'UTF8'), 'hex')
      || '/sha256/' || substr(content_hash, 8)
  ),
  -- Stored ciphertext has the envelope v1 shape: 0x01 || nonce(12) || ciphertext || tag(16).
  ADD CONSTRAINT artifact_references_envelope CHECK (
    encryption = 'none' OR (
      byte_length >= 29
      AND (inline_content IS NULL OR substr(inline_content, 1, 1) = '\x01'::bytea)
    )
  ),
  -- Credentials belong to the Wave 5 credential store, not here.
  ADD CONSTRAINT artifact_references_no_credential CHECK (privacy_class <> 'credential'),
  -- Every class except public_scene is ciphertext under a recorded data key version.
  ADD CONSTRAINT artifact_references_private_encrypted
    CHECK ((privacy_class = 'public_scene') = (encryption = 'none')),
  ADD CONSTRAINT artifact_references_data_key_version
    CHECK ((encryption = 'none') = (data_key_version IS NULL)),
  -- MATCH SIMPLE: a public row (NULL version) references no key.
  ADD CONSTRAINT artifact_references_data_key
    FOREIGN KEY (tenant_id, world_id, privacy_class, data_key_version)
    REFERENCES clockgrove.artifact_data_keys (tenant_id, world_id, privacy_class, key_version);

-- Artifact metadata is append-only for the runtime role, like events.
REVOKE UPDATE, DELETE ON clockgrove.artifact_references FROM clockgrove_runtime;
GRANT SELECT, INSERT ON clockgrove.artifact_data_keys TO clockgrove_runtime;
GRANT UPDATE (kek_id, wrapped_key) ON clockgrove.artifact_data_keys TO clockgrove_runtime;
