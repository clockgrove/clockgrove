-- Model-backed turns (Wave 5 RW-0506, issue 19). A committed turn names the model that answered it:
-- `scripted-fixture-v1` for the fixture, or the route alias a real model answered under (for
-- example `stevie.pilot`). The 0034 check admitted only the fixture; this admits a bounded model
-- name and nothing else, so a turn's row can never hold free text. Rows stay immutable (0034).
ALTER TABLE clockgrove.conversation_turns DROP CONSTRAINT conversation_turns_model_check;
ALTER TABLE clockgrove.conversation_turns
  ADD CONSTRAINT conversation_turns_model_check CHECK (model ~ '^[a-z0-9][a-z0-9._-]{0,127}$');
