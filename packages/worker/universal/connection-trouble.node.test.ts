import { expect, test } from 'vitest'
import {
	buildExpiredSecretHref,
	buildIntegrationReconnectHref,
	expiredSecretCopy,
	humanizeConnectionName,
	integrationAuthFailureCopy,
	isVendorLikelyMcpError,
	toIntegrationAuthFailureView,
} from './connection-trouble.ts'

test('connection trouble copy names the actor and keeps vendor items off the you-queue', () => {
	expect(humanizeConnectionName('google')).toBe('Google')
	expect(humanizeConnectionName('home-assistant')).toBe('Home Assistant')

	const rejected = integrationAuthFailureCopy({
		name: 'google',
		accountLabel: 'kent@gmail.com',
		reason: 'provider_rejected',
		providerError: 'invalid_grant',
		providerErrorDescription: 'Token has been expired or revoked.',
	})
	expect(rejected).toMatchObject({
		title: 'Google · kent@gmail.com stopped working',
		who: 'you',
		doLabel: 'Reconnect',
		reconnectable: true,
		href: '/connect/oauth?provider=google&loginHint=kent%40gmail.com',
	})
	expect(rejected.why).toContain('invalid_grant')

	const outage = integrationAuthFailureCopy({
		name: 'google',
		accountLabel: 'kent@gmail.com',
		reason: 'provider_unavailable',
		httpStatus: 503,
	})
	expect(outage).toMatchObject({
		who: 'the-service',
		reconnectable: false,
		href: '/account/integrations/google',
	})
	expect(outage.why).toContain('HTTP 503')
	expect(outage.why).toContain('not a dead sign-in')

	const platformSecret = integrationAuthFailureCopy({
		name: 'google',
		lane: 'platform',
		reason: 'missing_secret',
	})
	expect(platformSecret).toMatchObject({
		who: 'kody',
		reconnectable: false,
	})

	const expired = expiredSecretCopy('githubAccessToken')
	expect(expired).toMatchObject({
		title: 'githubAccessToken expired',
		who: 'you',
		href: buildExpiredSecretHref('githubAccessToken'),
	})

	expect(isVendorLikelyMcpError('HTTP 503 from upstream')).toBe(true)
	expect(isVendorLikelyMcpError('fetch failed')).toBe(true)
	expect(isVendorLikelyMcpError('Token exchange failed.')).toBe(false)
	expect(isVendorLikelyMcpError(null)).toBe(false)

	const view = toIntegrationAuthFailureView({
		name: 'spotify',
		reason: 'missing_refresh_token',
		occurredAt: '2026-09-01T00:00:00.000Z',
	})
	expect(view.reconnectHref).toBe(
		buildIntegrationReconnectHref({ name: 'spotify' }),
	)
	expect(view.reconnectable).toBe(true)
	expect(view.who).toBe('you')
})
