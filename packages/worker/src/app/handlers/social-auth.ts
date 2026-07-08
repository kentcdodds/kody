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
import { type AnySocialAuthProvider } from '#app/social-auth-provider-factory.ts'
import { finishSocialAuth, startSocialAuth } from '#app/social-auth-flow.ts'
import {
	listConfiguredSocialAuthProviders,
	isSocialAuthProviderConfigured,
	isSocialAuthProviderName,
	type SocialAuthProviderName,
} from '#app/social-auth-providers.ts'
import { type routes } from '#app/routes.ts'
import {
	destroyOAuthTransactionCookie,
	setOAuthTransactionSecret,
} from '#app/oauth-transaction.ts'

function buildLoginErrorRedirect(
	request: Request,
	message: string,
	extraCookies: Array<string> = [],
) {
	const url = new URL('/login', request.url)
	url.searchParams.set('error', message)
	const headers = new Headers({ Location: url.toString() })
	for (const cookie of extraCookies) {
		headers.append('Set-Cookie', cookie)
	}
	return new Response(null, { status: 302, headers })
}

function buildPostAuthRedirect(request: Request, returnTo: string | undefined) {
	const target = normalizeRedirectTo(returnTo ?? null) ?? '/account'
	return Response.redirect(new URL(target, request.url), 302)
}

function resolveSocialAuthProvider(
	env: Env,
	providerName: string,
	request: Request,
):
	| { error: Response }
	| {
			authProvider: AnySocialAuthProvider
			providerName: SocialAuthProviderName
	  } {
	if (!isSocialAuthProviderName(providerName)) {
		return { error: new Response('Not found', { status: 404 }) }
	}
	if (!isSocialAuthProviderConfigured(env, providerName)) {
		return {
			error: buildLoginErrorRedirect(
				request,
				`${providerName} sign-in is not configured.`,
			),
		}
	}
	const authProvider = createSocialAuthProvider(env, providerName, request.url)
	if (!authProvider) {
		return {
			error: buildLoginErrorRedirect(
				request,
				`${providerName} sign-in is not configured.`,
			),
		}
	}
	return { authProvider, providerName }
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
	const requestIp = getRequestIp(input.request) ?? undefined
	const path = new URL(input.request.url).pathname

	if (await isTwoFactorEnabled(input.env.APP_DB, input.userId)) {
		setVerifySessionSecret(input.env.COOKIE_SECRET)
		const secure = isSecureRequest(input.request)
		const verifyCookie = await createVerifySessionCookie(
			{
				id: String(input.userId),
				email: input.email,
				rememberMe: false,
			},
			secure,
		)
		void logAuditEvent({
			category: 'auth',
			action: 'social_login_2fa_challenge',
			result: 'success',
			email: input.email,
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
			id: String(input.userId),
			email: input.email,
			rememberMe: false,
		},
		secure,
	)

	void logAuditEvent({
		category: 'auth',
		action: input.isNewUser ? 'social_signup' : 'social_login',
		result: 'success',
		email: input.email,
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
		}): Promise<Response> {
			const resolved = resolveSocialAuthProvider(env, params.provider, request)
			if ('error' in resolved) return resolved.error
			const { authProvider, providerName } = resolved

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
		}): Promise<Response> {
			const resolved = resolveSocialAuthProvider(env, params.provider, request)
			if ('error' in resolved) return resolved.error
			const { authProvider, providerName } = resolved

			const requestIp = getRequestIp(request) ?? undefined
			const path = new URL(request.url).pathname
			let destroyTransactionCookie: string | undefined

			try {
				const finished = await finishSocialAuth(authProvider, request, env)

				const resolvedUser = await resolveSocialAuthUser({
					env,
					result: finished.result,
					inviteCode: finished.inviteCode,
				})

				return await issueSessionForSocialAuth({
					request,
					env,
					userId: resolvedUser.userId,
					email: resolvedUser.email,
					provider: resolvedUser.provider,
					isNewUser: resolvedUser.isNewUser,
					destroyTransactionCookie: finished.destroyTransactionCookie,
					returnTo: finished.returnTo,
				})
			} catch (error) {
				if (!destroyTransactionCookie) {
					setOAuthTransactionSecret(env.COOKIE_SECRET)
					destroyTransactionCookie =
						await destroyOAuthTransactionCookie(request)
				}
				const clearTransactionCookie = destroyTransactionCookie

				if (error instanceof SocialAuthResolutionError) {
					void logAuditEvent({
						category: 'auth',
						action: 'social_login',
						result: 'failure',
						ip: requestIp,
						path,
						reason: error.message,
					})
					return buildLoginErrorRedirect(request, error.message, [
						clearTransactionCookie,
					])
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
					[clearTransactionCookie],
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
