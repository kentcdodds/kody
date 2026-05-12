UPDATE users
SET
	username = '__username_backfill__' || id,
	updated_at = CURRENT_TIMESTAMP;

UPDATE users
SET
	username = CASE
		WHEN email = 'me@kentcdodds.com' THEN 'kentcdodds'
		ELSE email
	END,
	updated_at = CURRENT_TIMESTAMP;
