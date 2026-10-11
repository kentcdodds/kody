-- Every job is a package job (ADR 0032). Stops when a non-package row is
-- still in the table, because no code path handles one any more: move it
-- into a package or delete it first. Does not change rows.

DROP TABLE IF EXISTS __migration_assertions;
CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'non-package job rows remain; retire them before 0004.'
WHERE EXISTS (
	SELECT 1 FROM jobs WHERE id NOT LIKE 'package-job:%'
);

DROP TABLE __migration_assertions;
