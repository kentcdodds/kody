-- Persist Cloudflare ownership and SSL validation records so org settings
-- (and list/sync) can show the TXT/HTTP values admins must publish. Without
-- these columns the claim flow only exposed a CNAME target.

ALTER TABLE package_app_custom_hostnames
	ADD COLUMN ownership_verification_json TEXT;

ALTER TABLE package_app_custom_hostnames
	ADD COLUMN ssl_validation_records_json TEXT;
