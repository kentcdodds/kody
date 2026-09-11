-- Cascade-delete community_forks when the forked saved package or its
-- entity source is removed. Inert community forks keep an entity_sources
-- row and no saved_packages row, so FOREIGN KEY ON DELETE CASCADE from
-- forked_package_id to saved_packages.id cannot be declared.
CREATE TRIGGER IF NOT EXISTS community_forks_delete_on_saved_package_delete
AFTER DELETE ON saved_packages
BEGIN
	DELETE FROM community_forks
	WHERE forker_user_id = OLD.user_id
		AND (
			forked_package_id = OLD.id
			OR forked_source_id = OLD.source_id
		);
END;

CREATE TRIGGER IF NOT EXISTS community_forks_delete_on_entity_source_delete
AFTER DELETE ON entity_sources
BEGIN
	DELETE FROM community_forks
	WHERE forked_source_id = OLD.id
		AND forker_user_id = OLD.user_id;
END;
