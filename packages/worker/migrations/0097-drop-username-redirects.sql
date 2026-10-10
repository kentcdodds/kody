-- HELD for the Teams P9 drop batch: ships with P9's sealed backup, not before.
--
-- Handles are permanent, so nothing reads or writes retired-username redirects
-- any more (#3192 removed the last reader and writer). Reserved old handles
-- live in `handles`, not here, so dropping this table frees nothing. Package
-- slug redirects (`package_kody_id_redirects`) are unrelated and stay.
DROP INDEX IF EXISTS idx_username_redirects_user_id;
DROP TABLE IF EXISTS username_redirects;
