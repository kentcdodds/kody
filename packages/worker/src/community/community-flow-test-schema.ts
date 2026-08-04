import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'

/**
 * Community flow workers-unit schema. Adds the community/social tables and the
 * profile columns the social migration introduced on top of the shared `users`
 * schema.
 */
export async function ensureCommunityFlowSchema(db: D1Database) {
	await ensureUsersTestSchema({
		db,
		columns: [
			'display_name',
			'bio',
			'avatar_key',
			'profile_visibility',
			'stripe_customer_id',
			'stripe_plan',
			'stripe_plan_refreshed_at',
		],
	})
	const statements = [
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
			hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
			is_private INTEGER NOT NULL DEFAULT 1 CHECK (is_private IN (0, 1)),
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
			external_check_until TEXT,
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
			trusted_commit TEXT,
			trusted_by_user_id TEXT,
			trusted_at TEXT,
			featured_at TEXT,
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
			listing_name TEXT,
			listing_kody_id TEXT,
			adopted_at TEXT,
			adoption_note TEXT,
			actor TEXT CHECK (actor IS NULL OR actor IN ('human', 'agent')),
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_community_forks_forked_package_id
			ON community_forks(forked_package_id)`,
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
		`CREATE TABLE IF NOT EXISTS user_follows (
			follower_user_id TEXT NOT NULL,
			followee_user_id TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			PRIMARY KEY (follower_user_id, followee_user_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_user_follows_followee_user_id
			ON user_follows(followee_user_id)`,
		`CREATE TABLE IF NOT EXISTS community_stars (
			listing_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			PRIMARY KEY (listing_id, user_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_community_stars_user_id
			ON community_stars(user_id)`,
		`CREATE TABLE IF NOT EXISTS community_activity_events (
			id TEXT PRIMARY KEY NOT NULL,
			actor_user_id TEXT NOT NULL,
			event_type TEXT NOT NULL CHECK (event_type IN ('listing_published', 'listing_updated')),
			listing_id TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_community_activity_events_actor_created
			ON community_activity_events(actor_user_id, created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_community_activity_events_listing_id
			ON community_activity_events(listing_id)`,
		`CREATE TABLE IF NOT EXISTS jobs (
			id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			source_id TEXT NOT NULL,
			published_commit TEXT,
			repo_check_policy_json TEXT,
			storage_id TEXT NOT NULL,
			params_json TEXT,
			schedule_json TEXT NOT NULL,
			timezone TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
			kill_switch_enabled INTEGER NOT NULL DEFAULT 0 CHECK (kill_switch_enabled IN (0, 1)),
			caller_context_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			last_run_at TEXT,
			last_run_status TEXT,
			next_run_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS published_bundle_artifacts (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			source_id TEXT NOT NULL,
			published_commit TEXT NOT NULL,
			artifact_kind TEXT NOT NULL,
			artifact_name TEXT,
			entry_point TEXT NOT NULL,
			kv_key TEXT NOT NULL,
			dependencies_json TEXT NOT NULL DEFAULT '[]',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
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

	// Best-effort ALTER for persisted worker DBs that already created the older
	// IF NOT EXISTS saved_packages table without the visibility column.
	try {
		await db
			.prepare(
				`ALTER TABLE saved_packages ADD COLUMN is_private INTEGER NOT NULL DEFAULT 1`,
			)
			.run()
	} catch {
		// Column already present.
	}
}
