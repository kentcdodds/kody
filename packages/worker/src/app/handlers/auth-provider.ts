import { type Action } from 'remix/router'
import { jsonResponse } from '#worker/json-response.ts'
import { getRequestIp, logAuditEvent } from '#app/audit-log.ts'
import { normalizeRedirectTo } from '#app/auth-redirect.ts'
import {
	createAuthCookie,
	destroyAuthCookie,
	isSecureRequest,
	readAuthSessionResult,
} from '#app/auth-session.ts'
import { getUniqueConstraintField } from '#app/database-errors.ts'
import { isNonProductionRuntime } from '#app/deployment-env.ts'
import { getAvailableUsernameFromBase } from '#app/generated-username.ts'
import { normalizeEmail } from '#app/normalize-email.ts'
import { type OauthLoginErrorCode } from '#app/oauth-login-errors.ts'
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
import { assignUserRole } from '#app/permissions-db.ts'
import { type routes } from '#app/routes.ts'
import { isTwoFactorEnabled } from '#app/two-factor.ts'
import { usernameFromEmail } from '#app/username.ts'
import {
	createVerifySessionCookie,
	setVerifySessionSecret,
} from '#app/verify-session.ts'
import { createDb, oauthConnectionsTable, usersTable } from '#worker/db.ts'
import { ensureDefaultEmailInbox } from '#worker/email/default-inbox.ts'
import { getPlatformEmailDomain } from '#worker/email/platform-address.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

/**
 * Accounts created through social login have no usable password until the
 * user sets one via password reset; verifyPassword rejects this sentinel.
 */
const oauthNoUsablePasswordHash = 'oauth_created_no_usable_password'

function getCallbackRedirectUri(env: Env, url: URL, provider: OauthProviderId) {
	const base = env.APP_BASE_URL ? new URL(env.APP_BASE_URL) : url
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

export function createAuthProvidersApiHandler(env: Env) {
	return {
		middleware: [],
		async handler() {
			return jsonResponse({
				ok: true,
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
			const redirectTo = normalizeRedirectTo(url.searchParams.get('redirectTo'))
			const providerParam = params.provider
			if (!isOauthProviderId(providerParam)) {
				return redirectToLoginWithError('unknown-provider', [], redirectTo)
			}
			if (!getOauthClientConfig(env, providerParam)) {
				return redirectToLoginWithError('not-configured', [], redirectTo)
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
				{ provider: providerParam, state, codeVerifier, redirectTo },
				isSecureRequest(request),
			)
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

			function fail(code: OauthLoginErrorCode, reason: string) {
				void logAuditEvent({
					category: 'auth',
					action: 'oauth_login',
					result: 'failure',
					ip: requestIp,
					path: url.pathname,
					reason,
				})
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

			async function issueLogin(user: { id: number; email: string }) {
				// Two-factor accounts get the same pending-verification gate as
				// password and passkey logins; the session cookie is only
				// issued once the TOTP code passes.
				if (await isTwoFactorEnabled(env.APP_DB, user.id)) {
					setVerifySessionSecret(env.COOKIE_SECRET)
					const verifyCookie = await createVerifySessionCookie(
						{ id: String(user.id), email: user.email, rememberMe: false },
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
					{ id: String(user.id), email: user.email, rememberMe: false },
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

			// 1. A known connection signs in its user directly.
			const connection = await db.findOne(oauthConnectionsTable, {
				where: {
					provider_name: provider,
					provider_id: profile.providerUserId,
				},
			})
			if (connection) {
				const user = await db.findOne(usersTable, {
					where: { id: connection.user_id },
				})
				if (!user) {
					return fail('account-error', 'connection_user_missing')
				}
				return issueLogin(user)
			}

			// 2. A signed-in user links the provider identity to their account.
			const { session } = await readAuthSessionResult(request)
			if (session) {
				const currentUser = await db.findOne(usersTable, {
					where: { id: Number(session.id) },
				})
				if (!currentUser) {
					return fail('account-error', 'session_user_missing')
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
				return redirect(redirectTo ?? '/account', [clearStateCookie])
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

			// 4. New account. Production signups require an invite code, which
			// the provider redirect cannot carry, so OAuth signup stays limited
			// to non-production runtimes (mirrors password signup gating).
			if (!isNonProductionRuntime(env)) {
				return fail('invite-required', 'invite_required')
			}

			const username = await getAvailableUsernameFromBase(
				env.APP_DB,
				profile.username ?? usernameFromEmail(email),
			)
			const stableUserId = await createStableUserIdFromEmail(email)
			let newUser: { id: number } | null = null
			try {
				const createdUser = await db.create(
					usersTable,
					{
						username,
						email,
						stable_user_id: stableUserId,
						password_hash: oauthNoUsablePasswordHash,
						email_verified_at: new Date().toISOString(),
					},
					{ returnRow: true },
				)
				newUser = { id: createdUser.id }
			} catch (error) {
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

			void logAuditEvent({
				category: 'auth',
				action: 'oauth_signup',
				result: 'success',
				email,
				ip: requestIp,
				path: url.pathname,
				reason: `provider=${provider}`,
			})
			return issueLogin({ id: newUser.id, email })
		},
	} satisfies Action<typeof routes.authProviderCallback>
}
