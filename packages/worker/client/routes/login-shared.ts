import { buildAuthLink } from '#client/auth-links.ts'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import { type Handle } from 'remix/ui'
import { type RouteLoaderResult } from '#client/route-loader.ts'
import {
	readRouterPathname,
	readRouterSearch,
} from '#client/router-location.tsx'
import { fetchPublicAuthConfig } from '#client/social-sign-in.ts'
import { type SignupMode } from '#universal/signup-mode.ts'

export type AuthMode = 'login' | 'signup'
export type AuthStatus = 'idle' | 'submitting' | 'success' | 'error'
export type SignupPanel = 'waiting-list' | 'invite' | 'open'

export function shouldOpenInviteSignup(searchParams: URLSearchParams) {
	if (searchParams.has('code') || searchParams.has('invite')) return true
	const panel = searchParams.get('panel')
	return panel === 'invite' || panel === 'code'
}

export function readPrefillInviteCode(searchParams: URLSearchParams) {
	for (const key of ['code', 'invite'] as const) {
		const value = searchParams.get(key)?.trim()
		if (value) return value
	}
	return ''
}

export function resolveSignupPanel(
	searchParams: URLSearchParams,
	signupMode: SignupMode,
): SignupPanel {
	if (shouldOpenInviteSignup(searchParams)) return 'invite'
	if (searchParams.get('panel') === 'waiting-list') return 'waiting-list'
	return signupMode === 'waitlist' ? 'waiting-list' : signupMode
}

export function buildAuthPath(mode: AuthMode, redirectTo: string | null) {
	const path = mode === 'signup' ? '/signup' : '/login'
	return buildAuthLink(path, redirectTo)
}

export function buildInviteSignupPath(redirectTo: string | null) {
	const params = new URLSearchParams()
	if (redirectTo) params.set('redirectTo', redirectTo)
	params.set('panel', 'invite')
	return `/signup?${params.toString()}`
}

export function getAuthModeFromPathname(pathname: string): AuthMode {
	return pathname === '/signup' ? 'signup' : 'login'
}

export function getSearchParams(handle: Handle) {
	return new URLSearchParams(readRouterSearch(handle))
}

export function getCurrentAuthMode(handle: Handle) {
	return getAuthModeFromPathname(readRouterPathname(handle))
}

export function getCurrentRedirectTo(handle: Handle) {
	return normalizeRedirectTo(getSearchParams(handle).get('redirectTo'))
}

/**
 * SPA navigations to /login and /signup prefetch the enabled providers so
 * the buttons render with the rest of the page (full-document loads embed
 * the same payload during SSR).
 */
export async function authProvidersRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const config = await fetchPublicAuthConfig(signal)
	// A failed fetch yields no loader data, so the route's fallback fetch
	// retries instead of rendering a permanently button-less page.
	if (!config) return {}
	return { authProviders: { ok: true, ...config } }
}
