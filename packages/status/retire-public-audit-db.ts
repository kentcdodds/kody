/**
 * AUDIT_DB is operator evidence, not product availability. The public status
 * registry has no audit_db card. This one-shot delete removes leftover public
 * history so retired rows cannot crowd the recent-incident LIMIT or linger in
 * uptime rollups.
 */

export const publicAuditDbRetiredMetaKey = 'audit_db_public_card_retired'
export const retiredPublicAuditDbComponent = 'audit_db'

export function retirePublicAuditDbData(
	exec: (query: string, ...bindings: Array<string | number>) => void,
) {
	exec(
		`DELETE FROM incidents WHERE component = ?`,
		retiredPublicAuditDbComponent,
	)
	exec(`DELETE FROM samples WHERE component = ?`, retiredPublicAuditDbComponent)
	exec(
		`DELETE FROM daily_stats WHERE component = ?`,
		retiredPublicAuditDbComponent,
	)
	exec(
		`DELETE FROM component_state WHERE component = ?`,
		retiredPublicAuditDbComponent,
	)
}
