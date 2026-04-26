ALTER TABLE secret_entries
ADD COLUMN allowed_packages TEXT NOT NULL DEFAULT '[]';
