import {
	type AppDatabase,
	passwordResetsTable,
	usersTable,
} from '#worker/db.ts'
import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import {
	type OAuthGrantHelpers,
	revokeAllOAuthGrantsForUser,
} from '#worker/oauth-grants.ts'
import {
	type ClearedAccountFactors,
	clearSecondFactorsAndConnections,
} from '#app/clear-account-factors.ts'

export type { ClearedAccountFactors }

export type ApplyPasswordChangeResult =
	| { ok: true; changedAtMs: number; cleared: ClearedAccountFactors | null }
	| {
			ok: false
			reason: 'oauth_provider_unavailable'
			stamped: false
	  }
	| {
			ok: false
			reason: 'oauth_grant_revoke_failed'
			stamped: boolean
			detail: string
			changedAtMs?: number
	  }

type ApplyPasswordChangeCredential =
	| { password: string; unusablePasswordHash?: undefined }
	| { unusablePasswordHash: string; password?: undefined }

/**
 * Stamp a new password hash, revoke MCP grants around the stamp, and drop
 * outstanding reset tokens. Callers map the result onto HTTP + audit events.
 *
 * Reset tokens stay until both revoke passes succeed so a retry remains
 * safe. `changedAtMs` is millisecond-precision so a freshly issued session
 * cookie can postdate `password_changed_at`.
 *
 * Password-reset confirmation passes `clearSecondFactorsAndConnections` so
 * attacker-added TOTP, passkeys, and linked providers cannot survive the
 * new password. Signed-in password change leaves those factors in place.
 */
export async function applyPasswordChange(
	input: {
		db: AppDatabase
		d1: D1Database
		helpers: OAuthGrantHelpers | undefined
		userId: number
		stableUserId: string
		clearSecondFactorsAndConnections?: boolean
	} & ApplyPasswordChangeCredential,
): Promise<ApplyPasswordChangeResult> {
	if (!input.helpers) {
		return { ok: false, reason: 'oauth_provider_unavailable', stamped: false }
	}

	const helpers = input.helpers
	async function revoke(): Promise<string | null> {
		try {
			await revokeAllOAuthGrantsForUser({
				helpers,
				userId: input.stableUserId,
			})
			return null
		} catch (error) {
			return error instanceof Error
				? error.message
				: 'oauth_grant_revoke_failed'
		}
	}

	// Revoke before stamping so a failed listing/revoke cannot leave refresh
	// tokens alive after the user thinks lockout succeeded.
	const beforeStampFailure = await revoke()
	if (beforeStampFailure) {
		return {
			ok: false,
			reason: 'oauth_grant_revoke_failed',
			stamped: false,
			detail: beforeStampFailure,
		}
	}

	const changedAtMs = Date.now()
	const passwordHash = await resolvePasswordHash(input)
	await input.db.update(usersTable, input.userId, {
		password_hash: passwordHash,
		password_changed_at: new Date(changedAtMs).toISOString(),
		updated_at: utcSqliteTimestamp(),
	})

	// Stamp, then revoke again so a grant created in that window is still
	// collected.
	const afterStampFailure = await revoke()
	if (afterStampFailure) {
		return {
			ok: false,
			reason: 'oauth_grant_revoke_failed',
			stamped: true,
			detail: afterStampFailure,
			changedAtMs,
		}
	}

	await input.db.deleteMany(passwordResetsTable, {
		where: { user_id: input.userId },
	})

	const cleared = input.clearSecondFactorsAndConnections
		? await clearSecondFactorsAndConnections(input.d1, input.userId)
		: null

	return { ok: true, changedAtMs, cleared }
}

async function resolvePasswordHash(input: ApplyPasswordChangeCredential) {
	if (input.unusablePasswordHash !== undefined) {
		return input.unusablePasswordHash
	}
	return createPasswordHash(input.password)
}
