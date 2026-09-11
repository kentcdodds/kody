import { packageShareGrantsFlagKey } from '#universal/feature-flags/registry.ts'
import { isFeatureEnabled } from '#worker/feature-flags/service.ts'
import { normalizeStableUserId } from '#worker/user-id.ts'

export { packageShareGrantsFlagKey }

export const packageShareGrantsDisabledMessage =
	'Package sharing is not enabled for this account.'

/**
 * Fail-closed gate for person-to-person package shares. Evaluation failures
 * and unresolved users are off so invite email cannot leak past a kill switch.
 */
export async function isPackageShareGrantsEnabled(input: {
	db: D1Database
	userId?: number | null
	stableUserId?: string | null
}): Promise<boolean> {
	try {
		let userId = input.userId ?? null
		if (userId == null && input.stableUserId) {
			const stable = normalizeStableUserId(input.stableUserId)
			if (!stable) return false
			const row = await input.db
				.prepare(`SELECT id FROM users WHERE stable_user_id = ?`)
				.bind(stable)
				.first<{ id: number }>()
			userId = row?.id ?? null
		}
		return await isFeatureEnabled(input.db, packageShareGrantsFlagKey, userId)
	} catch {
		return false
	}
}

async function setPackageShareGrantsEnabledForTests(
	db: D1Database,
	enabled: boolean,
) {
	await db
		.prepare(
			`INSERT INTO feature_flags (key, enabled, note)
			 VALUES (?, ?, 'test')
			 ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled`,
		)
		.bind(packageShareGrantsFlagKey, enabled ? 1 : 0)
		.run()
}

export async function enablePackageShareGrantsForTests(db: D1Database) {
	await setPackageShareGrantsEnabledForTests(db, true)
}

export async function disablePackageShareGrantsForTests(db: D1Database) {
	await setPackageShareGrantsEnabledForTests(db, false)
}
