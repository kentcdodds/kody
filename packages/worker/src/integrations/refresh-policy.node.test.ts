import { expect, test } from 'vitest'
import { inferIntegrationRefreshPolicy } from './refresh-policy.ts'

test('refresh is required when a refresh token or access-token expiry is present', () => {
	for (const payload of [
		{ access_token: 'a', refresh_token: 'r' },
		{ access_token: 'a', refresh_token: 'r', expires_in: 28_800 },
		{ access_token: 'a', expires_in: 3600 },
		{ access_token: 'a', expires_in: '3600' },
		{ access_token: 'a', expires_at: '2026-10-01T00:00:00.000Z' },
		{ access_token: 'a', expires_at: 1_790_000_000 },
	]) {
		expect(inferIntegrationRefreshPolicy(payload)).toBe('required')
	}

	for (const payload of [
		{ access_token: 'a', token_type: 'bearer', scope: 'repo' },
		{ access_token: 'a', refresh_token: '   ' },
		{ access_token: 'a', refresh_token: null, expires_in: null },
		{ access_token: 'a', expires_in: 0 },
		{ access_token: 'a', expires_in: '' },
		{ access_token: 'a', expires_at: 'never' },
	]) {
		expect(inferIntegrationRefreshPolicy(payload)).toBe('not_applicable')
	}
})
