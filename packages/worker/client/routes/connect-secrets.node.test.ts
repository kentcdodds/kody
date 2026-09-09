import { expect, test } from 'vitest'
import { allowHostsButtonLabel } from './account-approval-shared.ts'
import {
	isConnectSecretsAlreadyAllowed,
	readConnectSecretsView,
} from './connect-secrets.tsx'

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
	rejectedHosts: [],
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

	expect(
		isConnectSecretsAlreadyAllowed({
			secrets: [
				{
					...secret,
					allowedHosts: ['gmail.googleapis.com', 'oauth2.googleapis.com'],
				},
			],
			approval: {
				...approval,
				rejectedHosts: [
					{
						host: 'api.ope',
						reason: 'unknown_suffix',
						message: 'truncated',
					},
				],
			},
		}),
	).toBe(true)

	expect(
		isConnectSecretsAlreadyAllowed({
			secrets: [secret],
			approval: {
				...approval,
				requestedHost: '',
				requestedHosts: [],
				rejectedHosts: [
					{
						host: 'api.ope',
						reason: 'unknown_suffix',
						message: 'truncated',
					},
				],
			},
		}),
	).toBe(false)

	expect(allowHostsButtonLabel(2, 0)).toBe('Allow all 2 hosts')
	expect(allowHostsButtonLabel(1, 1)).toBe('Allow access')
	expect(allowHostsButtonLabel(2, 1)).toBe('Allow 2 valid hosts')

	expect(
		readConnectSecretsView({
			hostCount: 1,
			rejectedCount: 1,
			completed: 'approve',
			alreadyAllowed: false,
		}),
	).toEqual({
		onlyInvalid: false,
		fullyAllowed: false,
		leftoverInvalid: true,
		showBackToSecrets: true,
	})
})
