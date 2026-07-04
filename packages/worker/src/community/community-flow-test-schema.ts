export async function ensureCommunityFlowSchema(db: D1Database) {
	const statements = [
		`CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
			username TEXT NOT NULL UNIQUE,
			email TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		)`,
		`CREATE TABLE IF NOT EXISTS saved_packages (
			id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			kody_id TEXT NOT NULL,
			description TEXT NOT NULL,
			tags_json TEXT NOT NULL DEFAULT '[]',
			search_text TEXT,
			source_id TEXT NOT NULL,
			has_app INTEGER NOT NULL DEFAULT 0 CHECK (has_app IN (0, 1)),
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_packages_user_kody_id
			ON saved_packages(user_id, kody_id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_packages_user_name
			ON saved_packages(user_id, name)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_packages_source_id
			ON saved_packages(source_id)`,
		`CREATE TABLE IF NOT EXISTS entity_sources (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			entity_kind TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			repo_id TEXT NOT NULL,
			published_commit TEXT,
			indexed_commit TEXT,
			manifest_path TEXT NOT NULL DEFAULT 'package.json',
			source_root TEXT NOT NULL DEFAULT '/',
			last_external_check_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_sources_user_entity
			ON entity_sources(user_id, entity_kind, entity_id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_sources_repo_id
			ON entity_sources(repo_id)`,
		`CREATE TABLE IF NOT EXISTS community_listings (
			id TEXT PRIMARY KEY NOT NULL,
			owner_user_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			source_id TEXT NOT NULL,
			kody_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL,
			tags_json TEXT NOT NULL DEFAULT '[]',
			search_text TEXT,
			readme_content TEXT,
			license TEXT NOT NULL,
			pinned_commit TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'delisted')),
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			published_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_community_listings_owner_package
			ON community_listings(owner_user_id, package_id)`,
		`CREATE TABLE IF NOT EXISTS community_forks (
			id TEXT PRIMARY KEY NOT NULL,
			listing_id TEXT NOT NULL,
			forker_user_id TEXT NOT NULL,
			origin_commit TEXT NOT NULL,
			forked_package_id TEXT NOT NULL,
			forked_source_id TEXT NOT NULL,
			target_kody_id TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		)`,
		`CREATE TABLE IF NOT EXISTS community_ratings (
			id TEXT PRIMARY KEY NOT NULL,
			listing_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
			adaptation_effort INTEGER NOT NULL CHECK (adaptation_effort BETWEEN 1 AND 5),
			note TEXT,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_community_ratings_listing_user
			ON community_ratings(listing_id, user_id)`,
		`CREATE TABLE IF NOT EXISTS community_reports (
			id TEXT PRIMARY KEY NOT NULL,
			listing_id TEXT NOT NULL,
			listing_name TEXT NOT NULL,
			listing_owner_user_id TEXT NOT NULL,
			reporter_user_id TEXT NOT NULL,
			reason TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
			resolved_by_user_id TEXT,
			resolved_at TEXT,
			resolution_note TEXT,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		)`,
		`CREATE TABLE IF NOT EXISTS community_bans (
			user_id TEXT PRIMARY KEY NOT NULL,
			banned_by_user_id TEXT NOT NULL,
			reason TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		)`,
		`CREATE TABLE IF NOT EXISTS repo_sessions (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			source_id TEXT NOT NULL,
			source_repo_id TEXT NOT NULL,
			session_branch TEXT NOT NULL,
			source_branch TEXT NOT NULL,
			base_commit TEXT NOT NULL,
			source_root TEXT NOT NULL DEFAULT '/',
			conversation_id TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			expires_at TEXT,
			last_checkpoint_at TEXT,
			last_checkpoint_commit TEXT,
			last_check_run_id TEXT,
			last_check_tree_hash TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
	]
	for (const statement of statements) {
		await db.prepare(statement).run()
	}
}
