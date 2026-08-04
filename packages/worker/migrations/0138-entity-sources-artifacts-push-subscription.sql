-- Per-repo Cloudflare Artifacts push event subscription id (cf.artifacts.repo.pushed).
-- Nullable: missing means ensure has not yet created a subscription for this source.
ALTER TABLE entity_sources
ADD COLUMN artifacts_push_event_subscription_id TEXT;
