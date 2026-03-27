ALTER TABLE secret_entries
ADD COLUMN allowed_hosts TEXT NOT NULL DEFAULT '[]';
