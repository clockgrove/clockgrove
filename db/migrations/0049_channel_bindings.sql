-- First-party channel assertions use the existing authenticated principal mapping. A binding
-- scopes one canonical session to one participant's channel thread; it grants no access.
ALTER TABLE clockgrove.conversation_sessions DROP CONSTRAINT conversation_sessions_channel_check;
ALTER TABLE clockgrove.conversation_sessions ADD CONSTRAINT conversation_sessions_channel_check
  CHECK (channel IN ('browser', 'cli', 'fake'));
ALTER TABLE clockgrove.conversation_sessions
  ADD CONSTRAINT conversation_sessions_scope_key UNIQUE (tenant_id, world_id, timeline_id, session_id),
  ADD CONSTRAINT conversation_sessions_channel_key UNIQUE (tenant_id, session_id, channel);

CREATE TABLE clockgrove.channel_bindings (
  tenant_id text NOT NULL,
  world_id text NOT NULL,
  timeline_id text NOT NULL,
  principal_id text NOT NULL,
  session_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('browser', 'cli', 'fake')),
  thread_id text NOT NULL CHECK (octet_length(thread_id) BETWEEN 1 AND 1024),
  privacy_class text NOT NULL DEFAULT 'conversation' CHECK (privacy_class = 'conversation'),
  PRIMARY KEY (tenant_id, world_id, timeline_id, principal_id, channel, thread_id),
  UNIQUE (tenant_id, session_id),
  FOREIGN KEY (tenant_id, session_id, channel)
    REFERENCES clockgrove.conversation_sessions (tenant_id, session_id, channel)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, world_id, timeline_id, session_id)
    REFERENCES clockgrove.conversation_sessions (tenant_id, world_id, timeline_id, session_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, session_id, principal_id)
    REFERENCES clockgrove.conversation_participants (tenant_id, session_id, principal_id)
    DEFERRABLE INITIALLY DEFERRED
);
INSERT INTO clockgrove.channel_bindings (tenant_id, world_id, timeline_id, principal_id, session_id, channel, thread_id)
  SELECT s.tenant_id, s.world_id, s.timeline_id, p.principal_id, s.session_id, s.channel, s.session_id
    FROM clockgrove.conversation_sessions s
    JOIN clockgrove.conversation_participants p USING (tenant_id, session_id);

ALTER TABLE clockgrove.channel_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE clockgrove.channel_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY channel_binding_isolation ON clockgrove.channel_bindings
  USING (clockgrove.runtime_can_access(tenant_id, privacy_class)
    AND principal_id = clockgrove.runtime_principal_id()
    AND clockgrove.runtime_conversation_participant(tenant_id, session_id)
    AND EXISTS (SELECT 1 FROM clockgrove.conversation_sessions s
      WHERE s.tenant_id = channel_bindings.tenant_id AND s.session_id = channel_bindings.session_id
        AND s.world_id = channel_bindings.world_id AND s.timeline_id = channel_bindings.timeline_id
        AND s.state <> 'deleted'))
  WITH CHECK (clockgrove.runtime_can_access(tenant_id, privacy_class)
    AND principal_id = clockgrove.runtime_principal_id()
    AND clockgrove.runtime_conversation_participant(tenant_id, session_id)
    AND EXISTS (SELECT 1 FROM clockgrove.conversation_sessions s
      WHERE s.tenant_id = channel_bindings.tenant_id AND s.session_id = channel_bindings.session_id
        AND s.world_id = channel_bindings.world_id AND s.timeline_id = channel_bindings.timeline_id
        AND s.state <> 'deleted'));
REVOKE ALL ON clockgrove.channel_bindings FROM PUBLIC;
GRANT SELECT, INSERT ON clockgrove.channel_bindings TO clockgrove_runtime;
CREATE TRIGGER channel_bindings_immutable_rows BEFORE UPDATE OR DELETE ON clockgrove.channel_bindings
  FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();
CREATE TRIGGER channel_bindings_immutable_truncate BEFORE TRUNCATE ON clockgrove.channel_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION clockgrove.reject_journal_mutation();

-- The normalized envelope is an encrypted conversation artifact. Its ID is deterministic per
-- input, so the existing artifact immutability check refuses altered retry metadata.
ALTER TABLE clockgrove.conversation_turn_fibers ADD COLUMN inbound_artifact_id text;
ALTER TABLE clockgrove.conversation_turn_fibers ADD CONSTRAINT turn_inbound_artifact
  FOREIGN KEY (tenant_id, inbound_artifact_id, privacy_class)
    REFERENCES clockgrove.artifact_references (tenant_id, artifact_id, privacy_class);
