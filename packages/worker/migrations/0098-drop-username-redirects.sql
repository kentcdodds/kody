-- Teams P9 contract: drop username_redirects (held draft #3194).
--
-- Handles are permanent, so nothing reads or writes retired-username redirects
-- any more (#3192 removed the last reader and writer). Reserved old handles
-- live in `handles`, not here. Package slug redirects
-- (`package_kody_id_redirects` / `package_slug_redirects`) are unrelated and stay.

DROP INDEX IF EXISTS idx_username_redirects_user_id;
DROP TABLE IF EXISTS username_redirects;
