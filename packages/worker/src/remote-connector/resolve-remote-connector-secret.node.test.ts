import { expect, test } from 'vitest'
import { resolveRemoteConnectorSharedSecret } from './resolve-remote-connector-secret.ts'

test('falls back to HOME_CONNECTOR_SHARED_SECRET for home kind', () => {
	expect(
		resolveRemoteConnectorSharedSecret('home', 'any', {
			HOME_CONNECTOR_SHARED_SECRET: 'legacy-secret',
		} as Env),
	).toBe('legacy-secret')
})

test('REMOTE_CONNECTOR_SECRETS overrides per kind and instance', () => {
	const env = {
		HOME_CONNECTOR_SHARED_SECRET: 'legacy-secret',
		REMOTE_CONNECTOR_SECRETS: {
			'custom:alpha': 'alpha-secret',
			'home:default': 'home-override',
		},
	} as Env
	expect(resolveRemoteConnectorSharedSecret('custom', 'alpha', env)).toBe(
		'alpha-secret',
	)
	expect(resolveRemoteConnectorSharedSecret('home', 'default', env)).toBe(
		'home-override',
	)
	expect(resolveRemoteConnectorSharedSecret('home', 'other', env)).toBe(
		'legacy-secret',
	)
})

test('non-home kind has no legacy fallback when map missing', () => {
	expect(
		resolveRemoteConnectorSharedSecret('custom', 'alpha', {
			HOME_CONNECTOR_SHARED_SECRET: 'legacy-secret',
		} as Env),
	).toBeUndefined()
})
