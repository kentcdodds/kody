import { secretProvidersFlagKey } from '#universal/feature-flags/registry.ts'
import { isFeatureEnabled } from '#worker/feature-flags/service.ts'
import { normalizeStableUserId } from '#worker/user-id.ts'
import { SecretProviderError } from './errors.ts'

export { secretProvidersFlagKey }

export const secretProvidersDisabledMessage =
	'External secret providers are not enabled for this account. An admin can enable the secret-providers flag for this account on /admin/feature-flags.'

/**
 * Fail-closed gate for pluggable secret providers. Evaluation failures and
 * unresolved users are off so placeholders cannot resolve past a kill switch.
 */
export async function isSecretProvidersEnabled(input: {
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
		return await isFeatureEnabled(input.db, secretProvidersFlagKey, userId)
	} catch {
		return false
	}
}

export async function assertSecretProvidersEnabled(input: {
	db: D1Database
	userId?: number | null
	stableUserId?: string | null
}) {
	if (!(await isSecretProvidersEnabled(input))) {
		throw new SecretProviderError(secretProvidersDisabledMessage)
	}
}

async function setSecretProvidersEnabledForTests(
	db: D1Database,
	enabled: boolean,
) {
	await db
		.prepare(
			`INSERT INTO feature_flags (key, enabled, note)
			 VALUES (?, ?, 'test')
			 ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled`,
		)
		.bind(secretProvidersFlagKey, enabled ? 1 : 0)
		.run()
}

export async function enableSecretProvidersForTests(db: D1Database) {
	await setSecretProvidersEnabledForTests(db, true)
}

export async function disableSecretProvidersForTests(db: D1Database) {
	await setSecretProvidersEnabledForTests(db, false)
}
