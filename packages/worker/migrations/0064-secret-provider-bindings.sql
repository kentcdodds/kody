-- Account-owner bindings for pluggable external secret providers, plus
-- per-package grants on canonical (provider, ref) pairs. Declaring
-- package.json#kody.secretProvider does not create a binding.
CREATE TABLE secret_provider_bindings (
	user_id TEXT NOT NULL,
	provider_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	door_secret_name TEXT NOT NULL,
	config_json TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	PRIMARY KEY (user_id, provider_id),
	FOREIGN KEY (package_id) REFERENCES saved_packages(id) ON DELETE CASCADE
);

CREATE INDEX idx_secret_provider_bindings_package
	ON secret_provider_bindings(package_id);

CREATE TABLE secret_provider_grants (
	user_id TEXT NOT NULL,
	provider_id TEXT NOT NULL,
	canonical_ref TEXT NOT NULL,
	package_id TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	PRIMARY KEY (user_id, provider_id, canonical_ref, package_id),
	FOREIGN KEY (package_id) REFERENCES saved_packages(id) ON DELETE CASCADE
);

CREATE INDEX idx_secret_provider_grants_user_package
	ON secret_provider_grants(user_id, package_id);
