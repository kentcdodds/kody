-- Usernames (personal org handles) are permanent, so nothing writes or reads
-- retired-username redirects any more. Package slug redirects are unrelated
-- and stay.
DROP INDEX IF EXISTS idx_username_redirects_user_id;
DROP TABLE IF EXISTS username_redirects;
