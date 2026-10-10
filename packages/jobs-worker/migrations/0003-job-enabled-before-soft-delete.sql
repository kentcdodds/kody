-- Remember whether a job was enabled when its owner was soft-deleted so
-- restore can put that flag back. Rows tombstoned before this column stay
-- disabled (the column is null and restore keeps enabled).

ALTER TABLE jobs ADD COLUMN enabled_before_soft_delete INTEGER
	CHECK (
		enabled_before_soft_delete IS NULL
		OR enabled_before_soft_delete IN (0, 1)
	);
