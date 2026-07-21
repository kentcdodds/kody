-- Marks a community fork as reviewed/trusted by the forker. Provenance stays
-- (fork row remains); adopted forks get self-authored-like secret read/use
-- auto-grant. Mutations still require allowed_packages.
ALTER TABLE community_forks ADD COLUMN adopted_at TEXT;
ALTER TABLE community_forks ADD COLUMN adoption_note TEXT;
