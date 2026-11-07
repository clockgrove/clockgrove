-- #699: the clock owner claim is the partition row (clock_owner_generation, clock_owner_id),
-- updated in place under the row lock. Each incarnation's claim attempts carry the generation it
-- observed first, so recovering a lost response needs no per-owner receipt history.
DROP TRIGGER clock_owner_claims_immutable_rows ON clockgrove.clock_owner_claims;
DROP TRIGGER clock_owner_claims_immutable_truncate ON clockgrove.clock_owner_claims;
DROP TABLE clockgrove.clock_owner_claims;
