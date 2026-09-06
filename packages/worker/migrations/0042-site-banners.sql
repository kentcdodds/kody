-- Operator-owned site announcement banners plus per-user dismissals.
-- Banner rows are global config (no user_id). Dismissals are user-scoped.

CREATE TABLE site_banners (
	id TEXT PRIMARY KEY NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
	priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 1000),
	title TEXT NOT NULL,
	body TEXT NOT NULL DEFAULT '',
	cta_href TEXT,
	cta_label TEXT,
	secondary_href TEXT,
	secondary_label TEXT,
	severity TEXT NOT NULL DEFAULT 'info' CHECK (
		severity IN ('info', 'warning', 'success', 'promo')
	),
	look TEXT NOT NULL DEFAULT 'strip' CHECK (look IN ('strip', 'promo', 'card')),
	icon TEXT,
	image_url TEXT,
	page_targeting TEXT NOT NULL DEFAULT 'all' CHECK (
		page_targeting IN ('all', 'routes')
	),
	route_patterns TEXT NOT NULL DEFAULT '[]',
	audience TEXT NOT NULL DEFAULT 'everyone' CHECK (
		audience IN ('everyone', 'logged_out', 'logged_in', 'users', 'plans')
	),
	audience_user_ids TEXT NOT NULL DEFAULT '[]',
	audience_plans TEXT NOT NULL DEFAULT '[]',
	dismissible INTEGER NOT NULL DEFAULT 1 CHECK (dismissible IN (0, 1)),
	starts_at TEXT,
	ends_at TEXT,
	created_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
	updated_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX site_banners_enabled_priority_idx ON site_banners (enabled, priority DESC);

CREATE TABLE site_banner_dismissals (
	banner_id TEXT NOT NULL REFERENCES site_banners (id) ON DELETE CASCADE,
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	dismissed_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	PRIMARY KEY (banner_id, user_id)
);

CREATE INDEX site_banner_dismissals_user_id_idx ON site_banner_dismissals (user_id);
