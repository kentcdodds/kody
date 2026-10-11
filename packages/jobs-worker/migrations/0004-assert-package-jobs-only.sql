-- Every job is a package job (ADR 0032). Stops when a non-package row is
-- still in the table, because no code path handles one any more: move it
-- into a package or delete it first. Does not change rows.
-- Mirrors packageIdFromJobId: case-sensitive prefix, non-blank package id.

DROP TABLE IF EXISTS __migration_assertions;
CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'non-package job rows remain; retire them before 0004.'
WHERE EXISTS (
	SELECT 1 FROM jobs
	WHERE substr(id, 1, 12) <> 'package-job:'
		OR instr(substr(id, 13), ':') = 0
		OR trim(substr(id, 13, instr(substr(id, 13), ':') - 1)) = ''
);

DROP TABLE __migration_assertions;
