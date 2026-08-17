/**
 * Idle AUDIT_DB cold-start flaps were recorded as public incidents and
 * failed uptime samples. This one-shot purge removes that false history
 * without touching other components.
 */

export const auditDbFalseAlarmPurgeMetaKey = 'audit_db_false_alarm_purged'
export const auditDbFalseAlarmComponent = 'audit_db'

export function purgeAuditDbFalseAlarmData(
	exec: (query: string, ...bindings: Array<string | number>) => void,
) {
	exec(`DELETE FROM incidents WHERE component = ?`, auditDbFalseAlarmComponent)
	exec(
		`DELETE FROM samples WHERE component = ? AND ok = 0`,
		auditDbFalseAlarmComponent,
	)
	exec(
		`UPDATE daily_stats SET failed = 0 WHERE component = ?`,
		auditDbFalseAlarmComponent,
	)
	exec(
		`UPDATE component_state
		SET status = 'operational', consecutive_failures = 0, consecutive_successes = 0
		WHERE component = ?`,
		auditDbFalseAlarmComponent,
	)
}
