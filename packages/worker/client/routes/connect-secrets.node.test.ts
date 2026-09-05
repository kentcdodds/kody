import { expect, test } from 'vitest'
import { isConnectSecretsAlreadyAllowed } from './connect-secrets.tsx'

const secret = {
	id: 'user:googleAccessToken',
	name: 'googleAccessToken',
	scope: 'user' as const,
	description: '',
	packageId: null,
	packageTitle: null,
	allowedHosts: ['oauth2.googleapis.com'],
	allowedPackages: [],
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	expiresAt: null,
	ttlMs: null,
}

const approval = {
	name: 'googleAccessToken',
	names: ['googleAccessToken'],
	scope: 'user' as const,
	requestedHost: 'gmail.googleapis.com',
	requestedHosts: ['gmail.googleapis.com', 'oauth2.googleapis.com'],
	requestedPackageId: null,
	currentAllowedHosts: ['oauth2.googleapis.com'],
	currentAllowedPackages: [],
}

test('connect secrets is already allowed only when every listed secret is present and every host is granted', () => {
	expect(
		isConnectSecretsAlreadyAllowed({
			secrets: [secret],
			approval,
		}),
	).toBe(false)

	expect(
		isConnectSecretsAlreadyAllowed({
			secrets: [
				{
					...secret,
					allowedHosts: ['gmail.googleapis.com', 'oauth2.googleapis.com'],
				},
			],
			approval,
		}),
	).toBe(true)

	expect(
		isConnectSecretsAlreadyAllowed({
			secrets: [],
			approval,
		}),
	).toBe(false)
})
