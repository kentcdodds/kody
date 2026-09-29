import { expect, test } from 'vitest'
import {
	getLegacyHostRedirectResponse,
	parseLegacyHosts,
} from './app-legacy-redirect.ts'

type RedirectEnv = Parameters<typeof getLegacyHostRedirectResponse>[0]['env']

const migrationEnv: RedirectEnv = {
	APP_BASE_URL: 'https://heykody.app',
	APP_LEGACY_HOSTS: 'heykody.dev',
	APP_LEGACY_REDIRECT: 'true',
}

test('legacy host redirect rewrites listed GET/HEAD navigation and leaves protocol surfaces alone', () => {
	expect(parseLegacyHosts('heykody.dev')).toEqual(['heykody.dev'])
	expect(parseLegacyHosts(' HeyKody.DEV., other.example ,heykody.dev')).toEqual(
		['heykody.dev', 'other.example'],
	)
	expect(parseLegacyHosts('')).toEqual([])
	expect(parseLegacyHosts(null)).toEqual([])

	const redirect = (url: string, init?: RequestInit, env = migrationEnv) =>
		getLegacyHostRedirectResponse({ request: new Request(url, init), env })
	const redirects = [
		redirect('https://heykody.dev/blog/some-post?utm=x'),
		redirect('https://heykody.dev/', { method: 'HEAD' }),
		// Prefix matching is segment-aware: lookalike paths still redirect.
		redirect('https://heykody.dev/mcp-guide'),
	]
	expect(
		redirects.map((response) => [
			response?.status,
			response?.headers.get('location'),
		]),
	).toEqual([
		[308, 'https://heykody.app/blog/some-post?utm=x'],
		[308, 'https://heykody.app/'],
		[308, 'https://heykody.app/mcp-guide'],
	])

	type PassThroughCase = [string, RequestInit?, RedirectEnv?]
	const passThrough: Array<PassThroughCase> = [
		...[undefined, '', 'false', '1', 'TRUE', 'yes'].map(
			(flag): PassThroughCase => [
				'https://heykody.dev/blog',
				undefined,
				{ ...migrationEnv, APP_LEGACY_REDIRECT: flag },
			],
		),
		...['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map(
			(method): PassThroughCase => [
				'https://heykody.dev/some/form',
				{ method },
			],
		),
		...[
			'/mcp',
			'/oauth/token',
			'/.well-known/oauth-authorization-server',
			'/.well-known/appspecific/com.tesla.3p.public-key.pem',
			'/auth/github/callback',
			'/webauthn/authentication',
			'/connect/oauth',
			'/health',
			'/health/db',
			'/__maintenance/reindex-capabilities',
		].map((pathname): PassThroughCase => [`https://heykody.dev${pathname}`]),
		// The canonical host itself is not a legacy host.
		['https://heykody.app/blog'],
		// Unlisted hosts (workers.dev backup trigger, package-app origin, local
		// dev) serve normally.
		['https://kody-production.kody-a99.workers.dev/'],
		// A misconfigured list containing the canonical host must not loop.
		[
			'https://heykody.app/blog',
			undefined,
			{ ...migrationEnv, APP_LEGACY_HOSTS: 'heykody.app,heykody.dev' },
		],
		// No canonical origin configured -> nothing to redirect to.
		[
			'https://heykody.dev/blog',
			undefined,
			{ ...migrationEnv, APP_BASE_URL: undefined },
		],
	]
	expect(
		passThrough.filter(([url, init, env]) => redirect(url, init, env) !== null),
	).toEqual([])
})
