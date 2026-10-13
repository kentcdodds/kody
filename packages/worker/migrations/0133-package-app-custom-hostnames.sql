-- Package-app custom hostnames (Cloudflare for SaaS on the package-app zone).
--
-- Resolution order later is app-level, then org-level, then kody.run. This
-- table stores both binding tiers. This change only serves app-level rows.
--
-- Serve a hostname only when hostname_status = 'active' AND ssl_status = 'active'.
-- Pending, moved, or deleted Cloudflare states must not receive package-app
-- traffic.
--
-- Store hostname lowercased. dns_missing_since is reserved for a later
-- grace-period cleanup job; nothing reads it yet.

CREATE TABLE package_app_custom_hostnames (
	id TEXT PRIMARY KEY NOT NULL,
	hostname TEXT NOT NULL,
	binding_kind TEXT NOT NULL CHECK (binding_kind IN ('app', 'org')),
	package_id TEXT,
	org_id TEXT,
	cloudflare_hostname_id TEXT,
	cloudflare_zone_id TEXT,
	hostname_status TEXT NOT NULL DEFAULT 'pending',
	ssl_status TEXT NOT NULL DEFAULT 'pending',
	verified_at TEXT,
	dns_missing_since TEXT,
	created_by_user_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	CHECK (
		(
			binding_kind = 'app'
			AND package_id IS NOT NULL
			AND org_id IS NULL
		)
		OR (
			binding_kind = 'org'
			AND org_id IS NOT NULL
			AND package_id IS NULL
		)
	),
	CHECK (hostname = lower(hostname)),
	FOREIGN KEY (package_id) REFERENCES saved_packages (id) ON DELETE CASCADE,
	FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX package_app_custom_hostnames_hostname_idx
	ON package_app_custom_hostnames (hostname);

CREATE INDEX package_app_custom_hostnames_package_id_idx
	ON package_app_custom_hostnames (package_id);

CREATE INDEX package_app_custom_hostnames_org_id_idx
	ON package_app_custom_hostnames (org_id);
