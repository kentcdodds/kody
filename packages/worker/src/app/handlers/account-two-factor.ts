import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { enum_, object, optional, parseSafe, string } from 'remix/data-schema'
import { getRequestIp, logAuditEvent } from '#app/audit-log.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'
import {
	cancelTwoFactorSetup,
	confirmTwoFactorSetup,
	createTwoFactorSetup,
	disableTwoFactor,
	findTwoFactorVerification,
	isTwoFactorEnabled,
	twoFactorSetupVerificationType,
	twoFactorVerificationType,
	verifyTwoFactorCode,
} from '#app/two-factor.ts'

export function createAccountTwoFactorHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			return renderAppPage({
				request,
				env,
				title: 'Two-factor authentication',
			})
		},
	} satisfies Action<typeof routes.accountTwoFactor>
}

const twoFactorActionSchema = object({
	intent: enum_(['setup', 'confirm', 'cancel', 'disable'] as const),
	code: optional(string()),
})

export function createAccountTwoFactorApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return jsonResponse(await loadTwoFactorStatus(env.APP_DB, user.userId))
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			const parsed = parseSafe(twoFactorActionSchema, body)
			if (!parsed.success) {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			const requestIp = getRequestIp(request) ?? undefined
			const intent = parsed.value.intent
			const code = parsed.value.code?.trim() ?? ''

			switch (intent) {
				case 'setup': {
					// A hijacked session must not be able to swap out the active
					// factor: re-enrollment requires disabling first, which demands
					// a current code.
					if (await isTwoFactorEnabled(env.APP_DB, user.userId)) {
						return jsonResponse(
							{
								ok: false,
								error:
									'Two-factor authentication is already enabled. Disable it first to set up a new authenticator.',
							},
							400,
						)
					}
					const { otpUri, secret } = await createTwoFactorSetup({
						db: env.APP_DB,
						userId: user.userId,
						accountName: user.email,
						issuer: url.hostname,
					})
					void logAuditEvent({
						category: 'account',
						action: 'two_factor_setup_start',
						result: 'success',
						email: user.email,
						ip: requestIp,
						path: url.pathname,
					})
					return jsonResponse({ ok: true, otpUri, secret })
				}
				case 'confirm': {
					if (!code) {
						return jsonResponse(
							{ ok: false, error: 'Verification code is required.' },
							400,
						)
					}
					// A stale pending row must never replace an already-active
					// factor (same reasoning as the setup guard).
					if (await isTwoFactorEnabled(env.APP_DB, user.userId)) {
						return jsonResponse(
							{
								ok: false,
								error: 'Two-factor authentication is already enabled.',
							},
							400,
						)
					}
					const pendingSetup = await findTwoFactorVerification(
						env.APP_DB,
						user.userId,
						twoFactorSetupVerificationType,
					)
					if (!pendingSetup) {
						return jsonResponse(
							{ ok: false, error: 'No two-factor setup is in progress.' },
							400,
						)
					}
					const codeValid = await verifyTwoFactorCode({
						db: env.APP_DB,
						userId: user.userId,
						code,
						type: twoFactorSetupVerificationType,
					})
					if (!codeValid) {
						void logAuditEvent({
							category: 'account',
							action: 'two_factor_enable',
							result: 'failure',
							email: user.email,
							ip: requestIp,
							path: url.pathname,
							reason: 'invalid_code',
						})
						return jsonResponse({ ok: false, error: 'Invalid code.' }, 400)
					}
					const promoted = await confirmTwoFactorSetup(env.APP_DB, user.userId)
					if (!promoted) {
						return jsonResponse(
							{ ok: false, error: 'No two-factor setup is in progress.' },
							400,
						)
					}
					void logAuditEvent({
						category: 'account',
						action: 'two_factor_enable',
						result: 'success',
						email: user.email,
						ip: requestIp,
						path: url.pathname,
					})
					return jsonResponse(
						await loadTwoFactorStatus(env.APP_DB, user.userId),
					)
				}
				case 'cancel': {
					await cancelTwoFactorSetup(env.APP_DB, user.userId)
					return jsonResponse(
						await loadTwoFactorStatus(env.APP_DB, user.userId),
					)
				}
				case 'disable': {
					// Disabling weakens account security, so require a fresh code
					// from the active authenticator (Epic Stack requires recent
					// re-verification; an inline code is the stateless equivalent).
					if (!code) {
						return jsonResponse(
							{ ok: false, error: 'Verification code is required.' },
							400,
						)
					}
					const codeValid = await verifyTwoFactorCode({
						db: env.APP_DB,
						userId: user.userId,
						code,
						type: twoFactorVerificationType,
					})
					if (!codeValid) {
						void logAuditEvent({
							category: 'account',
							action: 'two_factor_disable',
							result: 'failure',
							email: user.email,
							ip: requestIp,
							path: url.pathname,
							reason: 'invalid_code',
						})
						return jsonResponse({ ok: false, error: 'Invalid code.' }, 400)
					}
					await disableTwoFactor(env.APP_DB, user.userId)
					void logAuditEvent({
						category: 'account',
						action: 'two_factor_disable',
						result: 'success',
						email: user.email,
						ip: requestIp,
						path: url.pathname,
					})
					return jsonResponse(
						await loadTwoFactorStatus(env.APP_DB, user.userId),
					)
				}
				default: {
					intent satisfies never
					return jsonResponse({ ok: false, error: 'Unknown intent.' }, 400)
				}
			}
		},
	} satisfies Action<typeof routes.accountTwoFactorApi>
}

async function loadTwoFactorStatus(db: D1Database, userId: number) {
	return {
		ok: true,
		enabled: await isTwoFactorEnabled(db, userId),
	}
}
