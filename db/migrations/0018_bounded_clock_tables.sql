-- #726: clock owner claims and admission receipts are bounded per partition. Rows stay immutable;
-- the runtime may only retire them, from the admission code under the partition row lock.

-- A claim keeps only the current and previous owner's receipts, the only owners that can still be
-- retrying a lost claim response.
DROP TRIGGER clock_owner_claims_immutable_rows ON clockgrove.clock_owner_claims;
CREATE TRIGGER clock_owner_claims_immutable_rows
  BEFORE UPDATE ON clockgrove.clock_owner_claims
  FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();
GRANT DELETE ON clockgrove.clock_owner_claims TO clockgrove_runtime;

-- Receipts name the owner generation that admitted them. A new admission retires receipts no
-- replay can reach: another generation or policy (both fenced before the lookup) or a horizon that
-- committed simulation time already covers.
ALTER TABLE clockgrove.clock_admissions
  ADD COLUMN owner_generation bigint NOT NULL DEFAULT 0 CHECK (owner_generation >= 0);
DROP TRIGGER clock_admissions_immutable_rows ON clockgrove.clock_admissions;
CREATE TRIGGER clock_admissions_immutable_rows
  BEFORE UPDATE ON clockgrove.clock_admissions
  FOR EACH ROW EXECUTE FUNCTION clockgrove.reject_journal_mutation();
GRANT DELETE ON clockgrove.clock_admissions TO clockgrove_runtime;
