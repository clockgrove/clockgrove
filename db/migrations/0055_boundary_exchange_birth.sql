-- Optional finite boundary balances must survive canonical birth reconstruction.
ALTER TABLE clockgrove_birth.birth_state_sections
  DROP CONSTRAINT birth_state_sections_section_check,
  ADD CONSTRAINT birth_state_sections_section_check
    CHECK (section IN ('environment', 'ecology', 'wellbeing', 'lifecycle', 'processes', 'boundaryExchanges'));
