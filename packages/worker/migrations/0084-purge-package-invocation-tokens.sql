-- HTTP package invocation tokens are gone from worker code. Purge leftover
-- rows now. The table drop ships in a follow-up migration after this code is
-- live (migrations run before worker upload; DROP TABLE in the same deploy
-- would 500 old workers still reading the table).
DELETE FROM package_invocation_tokens;
