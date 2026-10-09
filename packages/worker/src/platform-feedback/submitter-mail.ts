import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export type PlatformFeedbackSubmitterMailTarget = {
	email: string
	suspendedAt: string | null
	emailOutboundPausedAt: string | null
}

export async function readPlatformFeedbackSubmitterMailTarget(input: {
	db: D1Database
	stableUserId: string
}): Promise<PlatformFeedbackSubmitterMailTarget | null> {
	const stableUserId = input.stableUserId.trim()
	if (!stableUserId) return null
	const row = await input.db
		.prepare(
			`SELECT email, suspended_at, email_outbound_paused_at FROM users
			 WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(stableUserId)
		.first<{
			email: string | null
			suspended_at: string | null
			email_outbound_paused_at: string | null
		}>()
	if (!row) return null
	return {
		email: row.email?.trim() ?? '',
		suspendedAt: row.suspended_at,
		emailOutboundPausedAt: row.email_outbound_paused_at,
	}
}

export function isPlatformFeedbackSubmitterMailable(
	submitter: PlatformFeedbackSubmitterMailTarget | null,
): submitter is PlatformFeedbackSubmitterMailTarget & { email: string } {
	return Boolean(
		submitter?.email &&
		!submitter.suspendedAt &&
		!submitter.emailOutboundPausedAt,
	)
}

export async function releasePlatformFeedbackEmailClaim(
	kv: KVNamespace,
	key: string,
	logTag: string,
) {
	try {
		await kv.delete(key)
	} catch (error) {
		console.warn(logTag, {
			key,
			error,
		})
	}
}
