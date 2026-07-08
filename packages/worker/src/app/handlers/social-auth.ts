import { type Action } from 'remix/router'
import {
	createAuthCookie,
	isSecureRequest,
	setAuthSessionSecret,
} from '#app/auth-session.ts'
import { normalizeRedirectTo } from '#app/auth-redirect.ts'
import { getRequestIp, logAuditEvent } from '#app/audit-log.ts'
import { isTwoFactorEnabled } from '#app/two-factor.ts'
import {
	createVerifySessionCookie,
	setVerifySessionSecret,
} from '#app/verify-session.ts'
import {
	resolveSocialAuthUser,
	SocialAuthResolutionError,
} from '#app/resolve-social-auth.ts'
import { createSocialAuthProvider } from '#app/social-auth-provider-factory.ts'
import { finishSocialAuth, startSocialAuth } from '#app/social-auth-flow.ts'
import {
	listConfiguredSocialAuthProviders,
	isSocialAuthProviderConfigured,
	isSocialAuthProviderName,
	type SocialAuthProviderName,
} from '#app/social-auth-providers.ts'
import { type routes } from '#app/routes.ts'
import { createDb, usersTable } from '#worker/db.ts'

function buildLoginErrorRedirect(request: Request, message: string) {
	const url = new URL('/login', request.url)
	url.searchParams.set('error', message)
	return Response.redirect(url, 302)
}

function buildPostAuthRedirect(request: Request, returnTo: string | undefined) {
	const target = normalizeRedirectTo(returnTo ?? null) ?? '/account'
	return Response.redirect(new URL(target, request.url), 302)
}

async function issueSessionForSocialAuth(input: {
	request: Request
	env: Env
	userId: number
	email: string
	provider: SocialAuthProviderName
	isNewUser: boolean
	destroyTransactionCookie: string
	returnTo?: string
}) {
	const db = createDb(input.env.APP_DB)
	const userRecord = await db.findOne(usersTable, {
		where: { id: input.userId },
	})
	if (!userRecord) {
		return buildLoginErrorRedirect(input.request, 'Unable to sign in.')
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	const path = new URL(input.request.url).pathname

	if (await isTwoFactorEnabled(input.env.APP_DB, userRecord.id)) {
		setVerifySessionSecret(input.env.COOKIE_SECRET)
		const secure = isSecureRequest(input.request)
		const verifyCookie = await createVerifySessionCookie(
			{
				id: String(userRecord.id),
				email: userRecord.email,
				rememberMe: false,
			},
			secure,
		)
		void logAuditEvent({
			category: 'auth',
			action: 'social_login_2fa_challenge',
			result: 'success',
			email: userRecord.email,
			ip: requestIp,
			path,
			reason: `provider=${input.provider}`,
		})

		const redirectTarget = normalizeRedirectTo(input.returnTo ?? null)
		const verifyUrl = new URL('/verify', input.request.url)
		if (redirectTarget) {
			verifyUrl.searchParams.set('redirectTo', redirectTarget)
		}

		const headers = new Headers({
			Location: verifyUrl.toString(),
		})
		headers.append('Set-Cookie', verifyCookie)
		headers.append('Set-Cookie', input.destroyTransactionCookie)
		return new Response(null, { status: 302, headers })
	}

	setAuthSessionSecret(input.env.COOKIE_SECRET)
	const secure = isSecureRequest(input.request)
	const sessionCookie = await createAuthCookie(
		{
			id: String(userRecord.id),
			email: userRecord.email,
			rememberMe: false,
		},
		secure,
	)

	void logAuditEvent({
		category: 'auth',
		action: input.isNewUser ? 'social_signup' : 'social_login',
		result: 'success',
		email: userRecord.email,
		ip: requestIp,
		path,
		reason: `provider=${input.provider}`,
	})

	const headers = new Headers({
		Location: buildPostAuthRedirect(input.request, input.returnTo).headers.get(
			'Location',
		)!,
	})
	headers.append('Set-Cookie', sessionCookie)
	headers.append('Set-Cookie', input.destroyTransactionCookie)
	return new Response(null, { status: 302, headers })
}

export function createSocialAuthStartHandler(env: Env) {
	return {
		middleware: [],
		async handler({
			request,
			params,
		}: {
			request: Request
			params: { provider: string }
		}) {
			const providerName = params.provider
			if (!isSocialAuthProviderName(providerName)) {
				return new Response('Not found', { status: 404 })
			}

			if (!isSocialAuthProviderConfigured(env, providerName)) {
				return buildLoginErrorRedirect(
					request,
					`${providerName} sign-in is not configured.`,
				)
			}

			const authProvider = createSocialAuthProvider(
				env,
				providerName,
				request.url,
			)
			if (!authProvider) {
				return buildLoginErrorRedirect(
					request,
					`${providerName} sign-in is not configured.`,
				)
			}

			const url = new URL(request.url)
			const returnTo = url.searchParams.get('redirectTo')
			const inviteCode = url.searchParams.get('inviteCode')

			try {
				return await startSocialAuth(authProvider, request, env, {
					returnTo,
					inviteCode,
				})
			} catch (error) {
				console.error(`Failed to start ${providerName} OAuth:`, error)
				return buildLoginErrorRedirect(
					request,
					`Unable to start ${providerName} sign-in.`,
				)
			}
		},
	}
}

export function createSocialAuthCallbackHandler(env: Env) {
	return {
		middleware: [],
		async handler({
			request,
			params,
		}: {
			request: Request
			params: { provider: string }
		}) {
			const providerName = params.provider
			if (!isSocialAuthProviderName(providerName)) {
				return new Response('Not found', { status: 404 })
			}

			if (!isSocialAuthProviderConfigured(env, providerName)) {
				return buildLoginErrorRedirect(
					request,
					`${providerName} sign-in is not configured.`,
				)
			}

			const authProvider = createSocialAuthProvider(
				env,
				providerName,
				request.url,
			)
			if (!authProvider) {
				return buildLoginErrorRedirect(
					request,
					`${providerName} sign-in is not configured.`,
				)
			}

			const requestIp = getRequestIp(request) ?? undefined
			const path = new URL(request.url).pathname

			try {
				const { result, returnTo, inviteCode, destroyTransactionCookie } =
					await finishSocialAuth(authProvider, request, env)

				const resolved = await resolveSocialAuthUser({
					env,
					result: result as Parameters<
						typeof resolveSocialAuthUser
					>[0]['result'],
					inviteCode,
				})

				return await issueSessionForSocialAuth({
					request,
					env,
					userId: resolved.userId,
					email: resolved.email,
					provider: resolved.provider,
					isNewUser: resolved.isNewUser,
					destroyTransactionCookie,
					returnTo,
				})
			} catch (error) {
				if (error instanceof SocialAuthResolutionError) {
					void logAuditEvent({
						category: 'auth',
						action: 'social_login',
						result: 'failure',
						ip: requestIp,
						path,
						reason: error.message,
					})
					return buildLoginErrorRedirect(request, error.message)
				}

				console.error(`Failed to finish ${providerName} OAuth:`, error)
				void logAuditEvent({
					category: 'auth',
					action: 'social_login',
					result: 'failure',
					ip: requestIp,
					path,
					reason: 'oauth_callback_failed',
				})
				return buildLoginErrorRedirect(
					request,
					`Unable to complete ${providerName} sign-in.`,
				)
			}
		},
	}
}

export function createSocialAuthProvidersHandler(env: Env) {
	return {
		middleware: [],
		async handler() {
			return Response.json({
				providers: listConfiguredSocialAuthProviders(env),
			})
		},
	} satisfies Action<typeof routes.authProviders>
}
