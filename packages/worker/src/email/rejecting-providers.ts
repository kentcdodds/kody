/**
 * Track mail providers (by MX host suffix) that are rejecting kody.codes with
 * blocklist / DBL responses. Holdable transactional mail to recipients whose
 * MX resolves to an active rejecting provider is skipped until rejections age
 * out or a successful delivery clears the provider.
 */

import { resolveRecipientMxProviders } from './mx-lookup.ts'
import { classifyRecipientDeliveryFailure } from './recipient-cooldown.ts'
import { type EmailDeliveryStatus } from './types.ts'
import { type EmailVerificationDeliveryStatus } from '#universal/email-verification-delivery.ts'

/** How long a provider stays "rejecting" after the last observed rejection. */
export const emailRejectingProviderTtlMs = 24 * 60 * 60 * 1000

export const emailProviderHoldMessage =
	'Your mail provider is blocking our domain right now, try another address.'

export type RejectingProviderRow = {
	providerKey: string
	lastRejectionAt: string
	rejectionCount: number
	lastRecipientDomain: string | null
	seeded: boolean
}

export async function listActiveRejectingProviders(input: {
	db: D1Database
	now?: Date
}): Promise<Array<RejectingProviderRow>> {
	const now = input.now ?? new Date()
	const cutoff = new Date(
		now.getTime() - emailRejectingProviderTtlMs,
	).toISOString()
	const result = await input.db
		.prepare(
			`SELECT provider_key, last_rejection_at, rejection_count,
			        last_recipient_domain, seeded
			 FROM email_rejecting_providers
			 WHERE last_rejection_at >= ?
			 ORDER BY last_rejection_at DESC`,
		)
		.bind(cutoff)
		.all<{
			provider_key: string
			last_rejection_at: string
			rejection_count: number
			last_recipient_domain: string | null
			seeded: number
		}>()
	return (result.results ?? []).map((row) => ({
		providerKey: row.provider_key,
		lastRejectionAt: row.last_rejection_at,
		rejectionCount: row.rejection_count,
		lastRecipientDomain: row.last_recipient_domain,
		seeded: row.seeded === 1,
	}))
}

export async function isRejectingProviderActive(input: {
	db: D1Database
	providerKey: string
	now?: Date
}): Promise<boolean> {
	const now = input.now ?? new Date()
	const cutoff = new Date(
		now.getTime() - emailRejectingProviderTtlMs,
	).toISOString()
	const row = await input.db
		.prepare(
			`SELECT 1 AS present
			 FROM email_rejecting_providers
			 WHERE provider_key = ? AND last_rejection_at >= ?`,
		)
		.bind(input.providerKey, cutoff)
		.first<{ present: number }>()
	return Boolean(row)
}

export async function recordRejectingProvidersForRecipient(input: {
	db: D1Database
	recipient: string
	status: EmailDeliveryStatus | EmailVerificationDeliveryStatus
	smtpResponse?: string | null
	smtpEnhancedStatusCode?: string | null
	now?: Date
	fetchImpl?: typeof fetch
}): Promise<Array<string>> {
	const deliveryClass = classifyRecipientDeliveryFailure({
		status: input.status,
		smtpResponse: input.smtpResponse,
		smtpEnhancedStatusCode: input.smtpEnhancedStatusCode,
	})
	if (deliveryClass !== 'sender_block') return []

	const mx = await resolveRecipientMxProviders({
		db: input.db,
		recipientOrDomain: input.recipient,
		now: input.now,
		fetchImpl: input.fetchImpl,
	})
	if (mx.providerKeys.length === 0) return []

	const now = input.now ?? new Date()
	const nowIso = now.toISOString()
	for (const providerKey of mx.providerKeys) {
		await input.db
			.prepare(
				`INSERT INTO email_rejecting_providers (
					provider_key, last_rejection_at, rejection_count,
					last_recipient_domain, seeded, created_at, updated_at
				 ) VALUES (?, ?, 1, ?, 0, ?, ?)
				 ON CONFLICT(provider_key) DO UPDATE SET
					last_rejection_at = excluded.last_rejection_at,
					rejection_count = email_rejecting_providers.rejection_count + 1,
					last_recipient_domain = excluded.last_recipient_domain,
					updated_at = excluded.updated_at`,
			)
			.bind(providerKey, nowIso, mx.domain || null, nowIso, nowIso)
			.run()
	}
	return mx.providerKeys
}

/**
 * A successful delivery to a recipient clears every provider key that
 * currently resolves for that address, so the hold lifts as soon as the
 * provider accepts mail again (for example after Spamhaus delisting).
 */
export async function clearRejectingProvidersForRecipient(input: {
	db: D1Database
	recipient: string
	now?: Date
	fetchImpl?: typeof fetch
}): Promise<Array<string>> {
	const mx = await resolveRecipientMxProviders({
		db: input.db,
		recipientOrDomain: input.recipient,
		now: input.now,
		fetchImpl: input.fetchImpl,
	})
	if (mx.providerKeys.length === 0) return []
	for (const providerKey of mx.providerKeys) {
		await input.db
			.prepare(`DELETE FROM email_rejecting_providers WHERE provider_key = ?`)
			.bind(providerKey)
			.run()
	}
	return mx.providerKeys
}

export async function findActiveRejectingProviderForRecipient(input: {
	db: D1Database
	recipient: string
	now?: Date
	fetchImpl?: typeof fetch
}): Promise<string | null> {
	const mx = await resolveRecipientMxProviders({
		db: input.db,
		recipientOrDomain: input.recipient,
		now: input.now,
		fetchImpl: input.fetchImpl,
	})
	for (const providerKey of mx.providerKeys) {
		if (
			await isRejectingProviderActive({
				db: input.db,
				providerKey,
				now: input.now,
			})
		) {
			return providerKey
		}
	}
	return null
}
