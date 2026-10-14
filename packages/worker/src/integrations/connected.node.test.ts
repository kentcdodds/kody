import { expect, test } from 'vitest'
import {
	integrationConnectedSql,
	isIntegrationConnected,
	oauthCredentialListStatus,
} from './connected.ts'

test('connected means connected_at is set; auth failure is a status overlay', () => {
	expect(isIntegrationConnected(null)).toBe(false)
	expect(isIntegrationConnected('2026-10-14T00:00:00.000Z')).toBe(true)
	expect(integrationConnectedSql('i.connected_at')).toBe(
		'i.connected_at IS NOT NULL',
	)
	expect(
		oauthCredentialListStatus({
			connectedAt: null,
			authFailedAt: null,
			authFailedReason: null,
		}),
	).toEqual({
		status: 'needs_attention',
		statusMessage: 'Not connected yet.',
	})
	expect(
		oauthCredentialListStatus({
			connectedAt: '2026-10-14T00:00:00.000Z',
			authFailedAt: null,
			authFailedReason: null,
		}),
	).toEqual({ status: 'ok', statusMessage: null })
	expect(
		oauthCredentialListStatus({
			connectedAt: '2026-10-14T00:00:00.000Z',
			authFailedAt: '2026-10-14T01:00:00.000Z',
			authFailedReason: 'provider_rejected',
		}),
	).toEqual({
		status: 'needs_attention',
		statusMessage: 'Reconnect needed (provider_rejected).',
	})
})
