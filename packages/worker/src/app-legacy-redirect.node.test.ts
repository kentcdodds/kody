import { expect, test } from 'vitest'
import {
	getLegacyHostRedirectResponse,
	parseLegacyHosts,
} from './app-legacy-redirect.ts'

const migrationEnv = {
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

	const response = getLegacyHostRedirectResponse({
		request: new Request('https://heykody.dev/blog/some-post?utm=x'),
		env: migrationEnv,
	})
	expect(response?.status).toBe(308)
	expect(response?.headers.get('location')).toBe(
		'https://heykody.app/blog/some-post?utm=x',
	)

	const headResponse = getLegacyHostRedirectResponse({
		request: new Request('https://heykody.dev/', { method: 'HEAD' }),
		env: migrationEnv,
	})
	expect(headResponse?.status).toBe(308)
	expect(headResponse?.headers.get('location')).toBe('https://heykody.app/')

	for (const flag of [undefined, '', 'false', '1', 'TRUE', 'yes']) {
		expect(
			getLegacyHostRedirectResponse({
				request: new Request('https://heykody.dev/blog'),
				env: { ...migrationEnv, APP_LEGACY_REDIRECT: flag },
			}),
		).toBeNull()
	}

	for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
		expect(
			getLegacyHostRedirectResponse({
				request: new Request('https://heykody.dev/some/form', { method }),
				env: migrationEnv,
			}),
		).toBeNull()
	}

	for (const pathname of [
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
	]) {
		expect(
			getLegacyHostRedirectResponse({
				request: new Request(`https://heykody.dev${pathname}`),
				env: migrationEnv,
			}),
		).toBeNull()
	}
	// Prefix matching is segment-aware: lookalike paths still redirect.
	expect(
		getLegacyHostRedirectResponse({
			request: new Request('https://heykody.dev/mcp-guide'),
			env: migrationEnv,
		}),
	).not.toBeNull()

	// The canonical host itself is not a legacy host.
	expect(
		getLegacyHostRedirectResponse({
			request: new Request('https://heykody.app/blog'),
			env: migrationEnv,
		}),
	).toBeNull()
	// Unlisted hosts (workers.dev backup trigger, package-app origin, local
	// dev) serve normally.
	expect(
		getLegacyHostRedirectResponse({
			request: new Request('https://kody-production.kody-a99.workers.dev/'),
			env: migrationEnv,
		}),
	).toBeNull()
	// A misconfigured list containing the canonical host must not loop.
	expect(
		getLegacyHostRedirectResponse({
			request: new Request('https://heykody.app/blog'),
			env: { ...migrationEnv, APP_LEGACY_HOSTS: 'heykody.app,heykody.dev' },
		}),
	).toBeNull()
	// No canonical origin configured -> nothing to redirect to.
	expect(
		getLegacyHostRedirectResponse({
			request: new Request('https://heykody.dev/blog'),
			env: { ...migrationEnv, APP_BASE_URL: undefined },
		}),
	).toBeNull()
})
