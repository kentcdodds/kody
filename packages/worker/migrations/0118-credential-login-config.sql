-- Login credentials (ADR 0068): a `login` credential's value holds its login
-- fields as one JSON object, and `config_json` holds the exchange the gateway
-- runs with them: the HTTPS URL on one of the credential's hosts, the body
-- template, and where the session token is in the response. The session token
-- is placed by the row's `inject_json`.
--
-- Other kinds leave it NULL. It holds no credential value.

ALTER TABLE secret_entries ADD COLUMN config_json TEXT
	CHECK (config_json IS NULL OR json_valid(config_json));
