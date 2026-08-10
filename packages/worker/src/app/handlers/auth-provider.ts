import { type Action } from 'remix/router'
import { jsonResponse } from '#worker/json-response.ts'
import { getRequestIp, logAuditEvent } from '#worker/audit-log.ts'
import { normalizeRedirectTo } from '#app/auth-redirect.ts'
import {
	createAuthCookie,
	destroyAuthCookie,
	isSecureRequest,
	readAuthSessionResult,
} from '#app/auth-session.ts'
import { getUniqueConstraintField } from '#worker/database-errors.ts'
import { maybeTagKitSubscriberOnSignup } from '#app/kit-signup.ts'
import { getAvailableUsernameFromBase } from '#worker/identity/generated-username.ts'
import {
	consumeInviteCode,
	type InviteConsumeFailureReason,
	normalizeInviteCode,
	releaseInviteUse,
} from '#app/invites.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import {
	oauthLoginErrorMessages,
	type OauthLoginErrorCode,
} from '#universal/oauth-login-errors.ts'
import {
	createOauthLoginStateCookie,
	destroyOauthLoginStateCookie,
	readOauthLoginState,
	setOauthLoginStateSecret,
} from '#app/oauth-login-state.ts'
import {
	buildAuthorizeRedirectUrl,
	generateOauthRandomValue,
	getEnabledOauthProviders,
	getOauthClientConfig,
	isOauthProviderId,
	oauthProviderDefinitions,
	resolveOauthProfile,
	type OauthProfile,
	type OauthProviderId,
} from '#app/oauth-providers.ts'
import { assignUserRole } from '#worker/identity/permissions-db.ts'
import { type routes } from '#universal/routes.ts'
import { isTwoFactorEnabled } from '#app/two-factor.ts'
import { usernameFromEmail } from '#worker/identity/username.ts'
import {
	createVerifySessionCookie,
	setVerifySessionSecret,
} from '#app/verify-session.ts'
import { createDb, oauthConnectionsTable, usersTable } from '#worker/db.ts'
import { ensureDefaultEmailInbox } from '#worker/email/default-inbox.ts'
import { getPlatformEmailDomain } from '#worker/email/platform-address.ts'
import {
	parseStoredPlanName,
	resolvePlanWrite,
	type PlanName,
} from '#universal/plans.ts'
import {
	createStableUserIdFromEmail,
	resolveUserStableId,
} from '#worker/user-id.ts'
import {
	getTurnstileSiteKey,
	verifyPublicFormProtection,
} from '#app/public-form-protection.ts'
import { getSignupMode } from '#universal/signup-mode.ts'
import { followDefaultWelcomeAccounts } from '#worker/community/welcome-follow.ts'
import { parseLegacyHosts } from '#worker/app-legacy-redirect.ts'

/**
 * Accounts created through social login have no usable password until the
 * user sets one via password reset; verifyPassword rejects this sentinel.
 */
const oauthNoUsablePasswordHash = 'oauth_created_no_usable_password'

function getCallbackRedirectUri(env: Env, url: URL, provider: OauthProviderId) {
	// The OAuth login state lives in a host-scoped cookie, so the provider must
	// call back to the host that started the flow whenever that host has a
	// registered callback: the canonical APP_BASE_URL host or a dual-served
	// legacy host (APP_LEGACY_HOSTS, both registered with providers during a
	// domain migration). Other hosts (the workers.dev backup trigger) keep
	// using the configured canonical callback as before.
	const base = (() => {
		if (!env.APP_BASE_URL) return url
		let canonical: URL
		try {
			canonical = new URL(env.APP_BASE_URL)
		} catch {
			return url
		}
		const requestHost = url.hostname.toLowerCase()
		if (
			requestHost === canonical.hostname.toLowerCase() ||
			parseLegacyHosts(env.APP_LEGACY_HOSTS).includes(requestHost)
		) {
			return url
		}
		return canonical
	})()
	return new URL(`/auth/${provider}/callback`, base).toString()
}

function redirect(location: string, cookies: Array<string>) {
	const headers = new Headers({ Location: location })
	for (const cookie of cookies) {
		headers.append('Set-Cookie', cookie)
	}
	return new Response(null, { status: 302, headers })
}

function redirectToLoginWithError(
	code: OauthLoginErrorCode,
	cookies: Array<string> = [],
	redirectTo: string | null = null,
) {
	// Keep the deep-link target alive across failures so retrying from the
	// login page still lands the user where they were headed.
	const redirectToSuffix = redirectTo
		? `&redirectTo=${encodeURIComponent(redirectTo)}`
		: ''
	return redirect(`/login?oauthError=${code}${redirectToSuffix}`, cookies)
}

/**
 * The login and connections UIs start flows via fetch (Accept: json) and
 * navigate to the returned authorize URL themselves: the CSP locks
 * `form-action`/`connect-src` to 'self', so neither a form POST redirect nor
 * a fetch-followed redirect may leave the origin — but a top-level JS
 * navigation may.
 */
function prefersJsonResponse(request: Request) {
	return (
		request.headers
			.get('Accept')
			?.toLowerCase()
			.includes('application/json') === true
	)
}

function inviteFailureToOauthError(
	reason: InviteConsumeFailureReason,
): OauthLoginErrorCode {
	switch (reason) {
		case 'missing':
			return 'invite-required'
		case 'not_found':
			return 'invite-invalid'
		case 'revoked':
			return 'invite-revoked'
		case 'expired':
			return 'invite-expired'
		case 'exhausted':
			return 'invite-exhausted'
		default: {
			const unreachable: never = reason
			return unreachable
		}
	}
}

export function createAuthProvidersApiHandler(env: Env) {
	return {
		middleware: [],
		async handler() {
			return jsonResponse({
				ok: true,
				signupMode: getSignupMode(env),
				turnstileSiteKey: getTurnstileSiteKey(env),
				providers: getEnabledOauthProviders(env).map((provider) => ({
					id: provider,
					label: oauthProviderDefinitions[provider].label,
				})),
			})
		},
	} satisfies Action<typeof routes.authProvidersApi>
}

export function createAuthProviderStartHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url, params }) {
			const wantsJson = prefersJsonResponse(request)
			const redirectTo = normalizeRedirectTo(url.searchParams.get('redirectTo'))
			const inviteCode = normalizeInviteCode(url.searchParams.get('inviteCode'))
			const { session } = await readAuthSessionResult(request)

			if (!session) {
				const body = (await request
					.clone()
					.json()
					.catch(() => ({}))) as Record<string, unknown>
				const protection = await verifyPublicFormProtection({
					env,
					request,
					body: typeof body === 'object' && body !== null ? body : {},
				})
				if (!protection.ok) return protection.response
			}

			function startError(code: OauthLoginErrorCode) {
				if (wantsJson) {
					return jsonResponse(
						{ ok: false, code, error: oauthLoginErrorMessages[code] },
						400,
					)
				}
				return redirectToLoginWithError(code, [], redirectTo)
			}

			const providerParam = params.provider
			if (!isOauthProviderId(providerParam)) {
				return startError('unknown-provider')
			}
			if (!getOauthClientConfig(env, providerParam)) {
				return startError('not-configured')
			}

			setOauthLoginStateSecret(env.COOKIE_SECRET)
			const state = generateOauthRandomValue()
			const codeVerifier = generateOauthRandomValue()
			const authorizeUrl = await buildAuthorizeRedirectUrl({
				env,
				provider: providerParam,
				state,
				codeVerifier,
				redirectUri: getCallbackRedirectUri(env, url, providerParam),
			})
			const stateCookie = await createOauthLoginStateCookie(
				{
					provider: providerParam,
					state,
					codeVerifier,
					redirectTo,
					inviteCode,
				},
				isSecureRequest(request),
			)
			// JSON mode: the CSP (`form-action`/`connect-src` locked to 'self')
			// blocks both form-POST redirects and fetch-followed redirects to
			// the provider, so the client fetches this endpoint and performs a
			// top-level navigation to the returned authorize URL itself.
			if (wantsJson) {
				return jsonResponse(
					{ ok: true, authorizeUrl },
					{ headers: { 'Set-Cookie': stateCookie } },
				)
			}
			return redirect(authorizeUrl, [stateCookie])
		},
	} satisfies Action<typeof routes.authProviderStart>
}

export function createAuthProviderCallbackHandler(env: Env) {
	const db = createDb(env.APP_DB)

	async function createConnection(input: {
		provider: OauthProviderId
		profile: OauthProfile
		userId: number
	}) {
		await db.create(oauthConnectionsTable, {
			provider_name: input.provider,
			provider_id: input.profile.providerUserId,
			user_id: input.userId,
			provider_display_name:
				input.profile.username ?? input.profile.displayName ?? undefined,
		})
	}

	return {
		middleware: [],
		async handler({ request, url, params }) {
			setOauthLoginStateSecret(env.COOKIE_SECRET)
			const secure = isSecureRequest(request)
			const clearStateCookie = await destroyOauthLoginStateCookie(secure)
			const requestIp = getRequestIp(request) ?? undefined
			const loginState = await readOauthLoginState(request)
			const redirectTo = normalizeRedirectTo(loginState?.redirectTo ?? null)
			const { session } = await readAuthSessionResult(request)

			function fail(code: OauthLoginErrorCode, reason: string) {
				void logAuditEvent({
					category: 'auth',
					action: 'oauth_login',
					result: 'failure',
					ip: requestIp,
					path: url.pathname,
					reason,
				})
				// A signed-in user is connecting a provider from their account
				// page; bouncing them to /login would immediately redirect back
				// and drop the message.
				if (session) {
					return redirect(`/account?oauthError=${code}`, [clearStateCookie])
				}
				return redirectToLoginWithError(code, [clearStateCookie], redirectTo)
			}

			const providerParam = params.provider
			if (!isOauthProviderId(providerParam)) {
				return fail('unknown-provider', 'unknown_provider')
			}
			const provider = providerParam
			if (!getOauthClientConfig(env, provider)) {
				return fail('not-configured', 'provider_not_configured')
			}

			if (url.searchParams.get('error')) {
				return fail('denied', 'provider_denied')
			}

			const stateFromQuery = url.searchParams.get('state')
			const code = url.searchParams.get('code')
			if (
				!loginState ||
				loginState.provider !== provider ||
				!stateFromQuery ||
				stateFromQuery !== loginState.state ||
				!code
			) {
				return fail('state-mismatch', 'state_mismatch')
			}

			let profile: OauthProfile
			try {
				profile = await resolveOauthProfile({
					env,
					provider,
					code,
					codeVerifier: loginState.codeVerifier,
					redirectUri: getCallbackRedirectUri(env, url, provider),
				})
			} catch (error) {
				console.error('OAuth login provider exchange failed:', error)
				return fail('provider-error', 'provider_exchange_failed')
			}

			async function issueLogin(user: {
				id: number
				stable_user_id: string | null
				email: string
			}) {
				const stableUserId = resolveUserStableId(user)
				// Two-factor accounts get the same pending-verification gate as
				// password and passkey logins; the session cookie is only
				// issued once the TOTP code passes.
				if (await isTwoFactorEnabled(env.APP_DB, user.id)) {
					setVerifySessionSecret(env.COOKIE_SECRET)
					const verifyCookie = await createVerifySessionCookie(
						{ stableUserId, email: user.email, rememberMe: false },
						secure,
					)
					void logAuditEvent({
						category: 'auth',
						action: 'oauth_login_2fa_challenge',
						result: 'success',
						email: user.email,
						ip: requestIp,
						path: url.pathname,
						reason: `provider=${provider}`,
					})
					const verifyPath = redirectTo
						? `/verify?redirectTo=${encodeURIComponent(redirectTo)}`
						: '/verify'
					return redirect(verifyPath, [
						verifyCookie,
						await destroyAuthCookie(secure),
						clearStateCookie,
					])
				}

				const sessionCookie = await createAuthCookie(
					{ stableUserId, email: user.email, rememberMe: false },
					secure,
				)
				void logAuditEvent({
					category: 'auth',
					action: 'oauth_login',
					result: 'success',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
					reason: `provider=${provider}`,
				})
				return redirect(redirectTo ?? '/account', [
					sessionCookie,
					clearStateCookie,
				])
			}

			const connection = await db.findOne(oauthConnectionsTable, {
				where: {
					provider_name: provider,
					provider_id: profile.providerUserId,
				},
			})

			// 1. A signed-in user links the provider identity to their account
			// (an existing connection for another user is a conflict, never an
			// account switch).
			if (session) {
				const currentUser = await db.findOne(usersTable, {
					where: { stable_user_id: session.stableUserId },
				})
				if (!currentUser) {
					return fail('account-error', 'session_user_missing')
				}
				if (connection) {
					if (connection.user_id === currentUser.id) {
						return redirect(`/account?oauthLinked=${provider}`, [
							clearStateCookie,
						])
					}
					return fail('connection-conflict', 'connection_conflict')
				}
				try {
					await createConnection({
						provider,
						profile,
						userId: currentUser.id,
					})
				} catch (error) {
					if (getUniqueConstraintField(error)) {
						return fail('connection-conflict', 'connection_conflict')
					}
					throw error
				}
				void logAuditEvent({
					category: 'auth',
					action: 'oauth_connection_linked',
					result: 'success',
					email: currentUser.email,
					ip: requestIp,
					path: url.pathname,
					reason: `provider=${provider}`,
				})
				return redirect(`/account?oauthLinked=${provider}`, [clearStateCookie])
			}

			// 2. A known connection signs its user in directly.
			if (connection) {
				const user = await db.findOne(usersTable, {
					where: { id: connection.user_id },
				})
				if (!user) {
					return fail('account-error', 'connection_user_missing')
				}
				return issueLogin(user)
			}

			// Without a provider-verified email we can neither match an
			// existing account nor create one safely.
			if (!profile.email || !profile.emailVerified) {
				return fail('no-verified-email', 'no_verified_email')
			}
			const email = normalizeEmail(profile.email)

			// 3. A provider-verified email matching an existing account links
			// the identity and signs that account in.
			const existingUser = await db.findOne(usersTable, { where: { email } })
			if (existingUser) {
				try {
					await createConnection({
						provider,
						profile,
						userId: existingUser.id,
					})
				} catch (error) {
					if (getUniqueConstraintField(error)) {
						return fail('connection-conflict', 'connection_conflict')
					}
					throw error
				}
				// The provider asserted ownership of this exact email, which is
				// the same proof the verification email flow provides.
				if (!existingUser.email_verified_at) {
					await db.update(usersTable, existingUser.id, {
						email_verified_at: new Date().toISOString(),
					})
				}
				return issueLogin(existingUser)
			}

			// 4. New account. Production requires a valid invite carried in the
			// signed OAuth state cookie (started from the invite signup panel).
			// Non-production stays open without an invite, but still consumes
			// one when supplied — same posture as password signup.
			let consumedInviteCode: string | null = null
			let consumedInvitePlan: PlanName | null = null
			async function releaseConsumedInvite() {
				if (!consumedInviteCode) return
				await releaseInviteUse({
					db: env.APP_DB,
					code: consumedInviteCode,
				})
				consumedInviteCode = null
				consumedInvitePlan = null
			}

			const inviteRequired = getSignupMode(env) !== 'open'
			const inviteCodeFromState = loginState.inviteCode
			if (inviteRequired || normalizeInviteCode(inviteCodeFromState)) {
				const inviteResult = await consumeInviteCode({
					db: env.APP_DB,
					code: inviteCodeFromState,
				})
				if (!inviteResult.ok) {
					return fail(
						inviteFailureToOauthError(inviteResult.reason),
						`invite_${inviteResult.reason}`,
					)
				}
				consumedInviteCode = inviteResult.invite.code
				consumedInvitePlan = parseStoredPlanName(inviteResult.invite.plan)
			}

			// Username / stable-id lookup must share the create try/catch so a
			// transient failure after consumeInviteCode still releases the invite.
			let username: string
			let stableUserId: string
			let newUser: {
				id: number
				stable_user_id: string
				email: string
			} | null = null
			try {
				username = await getAvailableUsernameFromBase(
					env.APP_DB,
					profile.username ?? usernameFromEmail(email),
				)
				stableUserId = await createStableUserIdFromEmail(email)
				const createdUser = await db.create(
					usersTable,
					{
						username,
						email,
						stable_user_id: stableUserId,
						password_hash: oauthNoUsablePasswordHash,
						email_verified_at: new Date().toISOString(),
						plan: resolvePlanWrite(consumedInvitePlan),
					},
					{ returnRow: true },
				)
				newUser = { id: createdUser.id, stable_user_id: stableUserId, email }
			} catch (error) {
				await releaseConsumedInvite()
				if (getUniqueConstraintField(error)) {
					return fail('account-error', 'user_create_conflict')
				}
				throw error
			}

			async function rollbackNewUser(userId: number) {
				try {
					await env.APP_DB.prepare(`DELETE FROM users WHERE id = ?`)
						.bind(userId)
						.run()
				} catch (error) {
					console.error('Failed to roll back OAuth-created user row:', error)
				}
				await releaseConsumedInvite()
			}

			let assigned = false
			try {
				;({ assigned } = await assignUserRole({
					db: env.APP_DB,
					userId: newUser.id,
					roleName: 'user',
				}))
			} catch (error) {
				console.error('Failed to assign default role at OAuth signup:', error)
			}
			if (!assigned) {
				await rollbackNewUser(newUser.id)
				return fail('account-error', 'default_role_assignment_failed')
			}

			try {
				await createConnection({ provider, profile, userId: newUser.id })
			} catch (error) {
				console.error('Failed to store OAuth connection at signup:', error)
				await rollbackNewUser(newUser.id)
				return fail('account-error', 'connection_create_failed')
			}

			// Best-effort, mirroring password signup: the automatic
			// {username}@<platform domain> inbox is also provisioned on first
			// inbound mail, so a failure here must not fail the signup.
			const platformEmailDomain = getPlatformEmailDomain(env)
			if (platformEmailDomain) {
				try {
					await ensureDefaultEmailInbox({
						db: env.APP_DB,
						userId: stableUserId,
						username,
						domain: platformEmailDomain,
					})
				} catch (error) {
					console.warn(
						'Failed to provision default email inbox at OAuth signup:',
						error,
					)
				}
			}

			// Best-effort: if this email is already in Kit (e.g. waitlist),
			// add signed_up::kody without removing other tags.
			await maybeTagKitSubscriberOnSignup({
				env,
				email,
			})
			await followDefaultWelcomeAccounts({
				db: env.APP_DB,
				followerUserId: stableUserId,
			})

			void logAuditEvent({
				category: 'auth',
				action: 'oauth_signup',
				result: 'success',
				email,
				ip: requestIp,
				path: url.pathname,
				reason: `provider=${provider}`,
			})
			if (consumedInviteCode) {
				void logAuditEvent({
					category: 'auth',
					action: 'invite_use',
					result: 'success',
					email,
					ip: requestIp,
					path: url.pathname,
					reason: `invite_code=${consumedInviteCode};stable_user_id=${stableUserId};provider=${provider};plan=${resolvePlanWrite(consumedInvitePlan)}`,
				})
			}
			return issueLogin(newUser)
		},
	} satisfies Action<typeof routes.authProviderCallback>
}
