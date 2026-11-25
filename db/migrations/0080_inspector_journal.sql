-- #327: the world debugger reads one window of a space's journal, and replays it to a position, under
-- the inspector's grant, rate limit (0028) and retirement (0023). Each read is audited in
-- `inspector_accesses` with subject `journal`; like a runtime-state read it names no command or entry.
ALTER TABLE clockgrove.inspector_accesses
  DROP CONSTRAINT inspector_accesses_subject_check,
  ADD CONSTRAINT inspector_accesses_subject_check CHECK (
    subject IN (
      'causal-chain', 'runtime-state', 'event', 'scheduled-action', 'client-view', 'agent-runs',
      'context-manifest', 'actor-documents', 'usage-events', 'actor-mute', 'journal'
    )
  );
