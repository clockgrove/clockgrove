-- Controlled disposable local rows exercise readers, not enrollment or hosted authority.
INSERT INTO clockgrove_auth."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
VALUES ('local-subject', 'Reader test', 'reader@example.test', true, now(), now());
INSERT INTO clockgrove_auth.session (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
VALUES ('local-session', 'local-reader-session', 'local-subject', now() + interval '1 hour', now(), now());
INSERT INTO clockgrove_management.principals VALUES ('principal-runtime', NULL);
INSERT INTO clockgrove_management.identity_links VALUES ('local', 'local-subject', 'identity-runtime', 'principal-runtime', NULL);
INSERT INTO clockgrove.world_memberships (
  tenant_id, world_id, timeline_id, space_id, principal_id, membership_id, persona_id, roles, grants, privacy_ceiling, committed_at
) VALUES ('tenant-runtime', 'world-runtime', 'timeline-runtime', 'space-runtime', 'principal-runtime', 'membership-runtime', 'persona-runtime',
  ARRAY['world-member'], ARRAY['runtime:no-op'], '{"version":1,"allowedCategories":["operator_evidence"]}', now());
