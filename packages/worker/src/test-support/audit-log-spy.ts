import { vi } from 'vitest'
import type * as AuditLog from '#app/audit-log.ts'

// Handlers fire `void logAuditEvent(...)` without awaiting it; with the real
// sink those promises resolve after a test ends and leak `audit-event` lines
// into the runner output once the console spies are restored. This setup file
// (wired into the node-unit project in vitest.node.config.ts) routes the sink
// through a shared spy so every test can assert the audit events it expects —
// and that none fire where they shouldn't — instead of stubbing the module in
// each test file.
//
// - Calls are cleared between tests (`clearMocks: true`), so assertions are
//   always per-test.
// - Files that test the real audit pipeline (e.g. asserting `audit_events`
//   rows) opt out with `vi.unmock('#app/audit-log.ts')`.
// - Files that need to override other exports (e.g. `getRequestIp`) declare
//   their own `vi.mock('#app/audit-log.ts', ...)`, which takes precedence.
export const logAuditEventSpy = vi.fn<typeof AuditLog.logAuditEvent>(
	async () => undefined,
)

vi.mock('#app/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		logAuditEvent: (...args: Parameters<typeof AuditLog.logAuditEvent>) =>
			logAuditEventSpy(...args),
	}
})

// Compact `action:result` view of every audit event recorded so far, in call
// order. Asserting on this catches extra unexpected events that a bare
// `toHaveBeenCalledWith` would let through.
export function auditEventSummaries() {
	return logAuditEventSpy.mock.calls.map(
		([event]) => `${event.action}:${event.result}`,
	)
}
