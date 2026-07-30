-- Delete obsolete integration-secret binding blobs from value storage.
-- The writer was removed before launch and current source has no readers.
--
-- Match the literal `_integration-secret:` prefix across every value scope.
-- Restart-safe: DELETE is idempotent and the assertion aborts if any row
-- survives.

DROP TABLE IF EXISTS __migration_assertions;

-- __migration_assertions intentionally uses CHECK (0) as an unreachable trap.
CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

DELETE FROM value_entries
WHERE name LIKE '\_integration-secret:%' ESCAPE '\';

INSERT INTO __migration_assertions (message)
SELECT '_integration-secret:* value rows remain; aborting 0115.'
WHERE EXISTS (
	SELECT 1
	FROM value_entries
	WHERE name LIKE '\_integration-secret:%' ESCAPE '\'
);

DROP TABLE __migration_assertions;
