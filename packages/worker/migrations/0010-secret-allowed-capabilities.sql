ALTER TABLE secret_entries
ADD COLUMN allowed_capabilities TEXT NOT NULL DEFAULT '[]';
