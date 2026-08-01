import { assertWithinStorageBytesEntitlement } from '#worker/entitlements/service.ts'
import { type UserMeterEnv } from '#worker/entitlements/user-meter-client.ts'

/**
 * Reserve authoritative D1 storage bytes and durably hand the resulting
 * absolute accounting state to UserMeter.
 *
 * Request handlers should pass their `waitUntil`; direct/service callers
 * without an ExecutionContext await the helper's caught accounting task.
 */
export async function reserveEmailStorageBytes(input: {
	db: D1Database
	env: UserMeterEnv
	userId: string
	email: string | null | undefined
	requested: number
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	if (input.waitUntil) {
		await assertWithinStorageBytesEntitlement({
			...input,
			waitUntil: input.waitUntil,
		})
		return
	}

	let accounting: Promise<unknown> | undefined
	await assertWithinStorageBytesEntitlement({
		...input,
		waitUntil: (promise) => {
			accounting = promise
		},
	})
	await accounting
}
