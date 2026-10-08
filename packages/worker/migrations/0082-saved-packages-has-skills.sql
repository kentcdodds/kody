ALTER TABLE saved_packages
ADD COLUMN has_skills INTEGER NOT NULL DEFAULT 0 CHECK (has_skills IN (0, 1));
