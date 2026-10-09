import { randomUUID } from 'node:crypto'
import { isExecutedDirectly } from '../node-runtime.ts'

/**
 * Insert `org.migrated` audit rows for every org in APP_DB (idempotent).
 */
export async function backfillOrgMigratedAuditEvents(input: {
	appDb: D1Database
	auditDb: D1Database
	now?: () => string
}) {
	const now = input.now ?? (() => new Date().toISOString())
	const orgs = await input.appDb
		.prepare(`SELECT id FROM orgs`)
		.all<{ id: string }>()
	const orgIds = (orgs.results ?? []).map((row) => row.id).filter(Boolean)
	if (orgIds.length === 0) return { inserted: 0, skipped: 0 }

	let inserted = 0
	let skipped = 0
	for (const orgId of orgIds) {
		const existing = await input.auditDb
			.prepare(
				`SELECT id FROM org_audit_events
				 WHERE org_id = ? AND action = 'org.migrated' AND result = 'success'
				 LIMIT 1`,
			)
			.bind(orgId)
			.first<{ id: string }>()
		if (existing) {
			skipped += 1
			continue
		}
		await input.auditDb
			.prepare(
				`INSERT INTO org_audit_events (
					id, org_id, actor_user_id, actor_username, credential_kind,
					credential_id, action, resource_type, resource_id, target_user_id,
					result, details_json, ip_hash, created_at
				) VALUES (?, ?, NULL, NULL, NULL, NULL, 'org.migrated', 'org', ?, NULL, 'success', NULL, NULL, ?)`,
			)
			.bind(randomUUID(), orgId, orgId, now())
			.run()
		inserted += 1
	}
	return { inserted, skipped }
}

async function main() {
	throw new Error(
		'CLI entry requires Cloudflare D1 bindings; import backfillOrgMigratedAuditEvents and pass appDb/auditDb from your runner.',
	)
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
