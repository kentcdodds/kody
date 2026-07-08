-- Additive indexes supporting the global retention prunes in
-- packages/worker/src/app/retention.ts. The retention queries order by a
-- time column across all users, which the existing (user_id, ...) composite
-- indexes cannot serve.

-- Age prune: WHERE created_at < ? ORDER BY created_at ASC.
CREATE INDEX IF NOT EXISTS idx_package_invocations_created_at
ON package_invocations(created_at);

-- Terminal workflow prune filters on status before ordering on the
-- completed_at/updated_at/created_at coalesce.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_updated_at
ON workflow_runs(status, updated_at);

-- Daily entitlement counter prune: WHERE day < ? ORDER BY day ASC.
CREATE INDEX IF NOT EXISTS idx_entitlement_daily_counters_day
ON entitlement_daily_counters(day);

-- Usage rollup prune: WHERE month < ? ORDER BY month ASC.
CREATE INDEX IF NOT EXISTS idx_usage_rollups_month
ON usage_rollups(month);

-- Email message age prune crosses users: WHERE user_id != 'system:email'
-- AND created_at < ? ORDER BY created_at ASC.
CREATE INDEX IF NOT EXISTS idx_email_messages_created_at
ON email_messages(created_at);

-- Email delivery event prune also orders on created_at across users.
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_created_at
ON email_delivery_events(created_at);

-- Runtime run age prune orders on started_at across users; the per-package
-- cap prune keeps using idx_package_runtime_runs_package_started.
CREATE INDEX IF NOT EXISTS idx_package_runtime_runs_started_at
ON package_runtime_runs(started_at);

-- Orphan runtime log prune orders on created_at across users.
CREATE INDEX IF NOT EXISTS idx_package_runtime_logs_created_at
ON package_runtime_logs(created_at);

-- Published bundle artifact prune orders on created_at across users.
CREATE INDEX IF NOT EXISTS idx_published_bundle_artifacts_created_at
ON published_bundle_artifacts(created_at);
