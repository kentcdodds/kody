-- Persistent git HTTPS auth uses long-lived `kody_at_…` API tokens directly.
-- Short-lived `git_access_tokens` / `kody_gt_…` from 0125 are unused; drop them.
DROP TABLE IF EXISTS git_access_tokens;
