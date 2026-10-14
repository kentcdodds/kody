-- Informational security audits for a package version. Each row is tied to the
-- exact published commit and capability-set fingerprint it reviewed, so a new
-- publish or a changed capability set reads as "not audited" again. Audits never
-- approve anything; owner approval stays in package_capability_approvals.

CREATE TABLE package_security_audits (
	id TEXT PRIMARY KEY NOT NULL,
	package_id TEXT NOT NULL,
	owner_user_id TEXT NOT NULL,
	published_commit TEXT NOT NULL,
	fingerprint TEXT NOT NULL,
	verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'concerns')),
	summary TEXT NOT NULL,
	auditor_label TEXT,
	recorded_by_user_id TEXT NOT NULL,
	recorded_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	FOREIGN KEY (package_id) REFERENCES saved_packages(id) ON DELETE CASCADE
);

CREATE INDEX package_security_audits_package_version_idx
	ON package_security_audits (package_id, published_commit, fingerprint);

CREATE INDEX package_security_audits_owner_user_id_idx
	ON package_security_audits (owner_user_id);
