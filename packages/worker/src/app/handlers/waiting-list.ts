import { object, parseSafe, string } from 'remix/data-schema'
import { type Action } from 'remix/router'
import { getRequestIp, logAuditEvent } from '#worker/audit-log.ts'
import { isNonProductionRuntime } from '#app/deployment-env.ts'
import {
	KitWaitlistError,
	resolveKitWaitlistSequenceId,
	resolveKitWaitlistTagId,
	subscribeToKitWaitlist,
} from '#app/kit-waitlist.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import { checkRateLimit, releaseRateLimit } from '#app/rate-limit.ts'
import { type routes } from '#app/routes.ts'
import { jsonResponse } from '#worker/json-response.ts'

export const waitingListRateLimitConfig = {
	maxRequests: 5,
	windowSeconds: 15 * 60,
}

const waitingListRequestSchema = object({
	email: string(),
	firstName: string(),
})

const MAX_FIRST_NAME_LENGTH = 80

function normalizeFirstName(value: string) {
	return value.trim().replace(/\s+/g, ' ')
}

function isPlausibleEmail(email: string) {
	// Intentionally light — Kit validates further. Block empty / obvious junk.
	return email.includes('@') && email.length <= 254
}

export function createWaitingListHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			let body: unknown
			try {
				body = await request.json()
			} catch {
				return jsonResponse({ ok: false, error: 'Invalid JSON payload.' }, 400)
			}

			const parsedBody = parseSafe(waitingListRequestSchema, body)
			if (!parsedBody.success) {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			const firstName = normalizeFirstName(parsedBody.value.firstName)
			const email = normalizeEmail(parsedBody.value.email)
			const requestIp = getRequestIp(request) ?? undefined

			if (!firstName || firstName.length > MAX_FIRST_NAME_LENGTH) {
				return jsonResponse(
					{ ok: false, error: 'First name is required.' },
					400,
				)
			}
			if (!isPlausibleEmail(email)) {
				return jsonResponse(
					{ ok: false, error: 'A valid email is required.' },
					400,
				)
			}

			const tagId = resolveKitWaitlistTagId(env.KIT_WAITLIST_TAG_ID)
			const sequenceId = resolveKitWaitlistSequenceId(
				env.KIT_WAITLIST_SEQUENCE_ID,
			)
			if (tagId === null || sequenceId === null) {
				return jsonResponse(
					{ ok: false, error: 'Waiting list is misconfigured.' },
					500,
				)
			}

			const rateLimitKey = `waiting-list:ip:${requestIp ?? 'unknown'}`
			const rateLimit = await checkRateLimit(
				env.APP_DB,
				rateLimitKey,
				waitingListRateLimitConfig,
			)
			if (!rateLimit.allowed) {
				void logAuditEvent({
					db: env.APP_DB,
					category: 'auth',
					action: 'waiting_list_join',
					result: 'rate_limited',
					email,
					ip: requestIp,
					path: url.pathname,
				})
				return jsonResponse(
					{
						ok: false,
						error: 'Too many waiting list requests. Please try again later.',
					},
					{
						status: 429,
						headers: {
							'Retry-After': String(rateLimit.retryAfterSeconds ?? 60),
						},
					},
				)
			}

			const apiKey = env.KIT_API_KEY?.trim()
			if (!apiKey) {
				if (isNonProductionRuntime(env)) {
					void logAuditEvent({
						db: env.APP_DB,
						category: 'auth',
						action: 'waiting_list_join',
						result: 'success',
						email,
						ip: requestIp,
						path: url.pathname,
						reason: 'kit_skipped_non_production',
					})
					return jsonResponse({
						ok: true,
						message: "You're on the list. We'll be in touch.",
					})
				}

				await releaseRateLimit(env.APP_DB, rateLimitKey).catch(() => undefined)
				void logAuditEvent({
					db: env.APP_DB,
					category: 'auth',
					action: 'waiting_list_join',
					result: 'failure',
					email,
					ip: requestIp,
					path: url.pathname,
					reason: 'kit_not_configured',
				})
				return jsonResponse(
					{
						ok: false,
						error:
							'Waiting list signup is temporarily unavailable. Please try again later.',
					},
					503,
				)
			}

			try {
				await subscribeToKitWaitlist({
					apiKey,
					email,
					firstName,
					tagId,
					sequenceId,
				})
			} catch (error) {
				console.error('Failed to subscribe waiting list contact to Kit:', error)
				const kitError = error instanceof KitWaitlistError ? error : null
				// Refund only transient failures. Client 4xx (bad email, etc.)
				// should still count against the IP budget.
				const shouldRefund =
					kitError === null ||
					kitError.kind === 'network' ||
					kitError.kind === 'server'
				if (shouldRefund) {
					await releaseRateLimit(env.APP_DB, rateLimitKey).catch(
						() => undefined,
					)
				}
				void logAuditEvent({
					db: env.APP_DB,
					category: 'auth',
					action: 'waiting_list_join',
					result: 'failure',
					email,
					ip: requestIp,
					path: url.pathname,
					reason: 'kit_subscribe_failed',
				})
				return jsonResponse(
					{
						ok: false,
						error:
							'Unable to join the waiting list right now. Please try again later.',
					},
					502,
				)
			}

			void logAuditEvent({
				db: env.APP_DB,
				category: 'auth',
				action: 'waiting_list_join',
				result: 'success',
				email,
				ip: requestIp,
				path: url.pathname,
			})
			return jsonResponse({
				ok: true,
				message: "You're on the list. We'll be in touch.",
			})
		},
	} satisfies Action<typeof routes.waitingList>
}
