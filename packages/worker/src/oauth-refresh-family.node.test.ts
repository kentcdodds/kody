import { expect, test } from 'vitest'
import {
	decideRefreshFamilyAction,
	hashOAuthToken,
	mcpOAuthRefreshFamilyReplayKey,
	mcpOAuthRefreshFamilySnapshotKey,
	parseOAuthRefreshToken,
	type RefreshFamilyGrantIds,
	type RefreshFamilySnapshot,
} from './oauth-refresh-family.ts'

function snapshot(overrides: Partial<RefreshFamilySnapshot> = {}) {
	return {
		userId: 'user-1',
		grantId: 'grant-1',
		currentRefreshTokenHash: 'hash-rt2',
		refreshToken: 'user-1:grant-1:rt2',
		accessToken: 'user-1:grant-1:at2',
		accessExpiresAt: 2_000,
		tokenType: 'bearer',
		scope: 'profile email',
		resource: 'https://heykody.dev/mcp',
		...overrides,
	} satisfies RefreshFamilySnapshot
}

function grant(overrides: Partial<RefreshFamilyGrantIds> = {}) {
	return {
		currentRefreshTokenHash: 'hash-rt2',
		previousRefreshTokenHash: 'hash-rt1',
		...overrides,
	} satisfies RefreshFamilyGrantIds
}

test('refresh family keys and token parsing stay grant-scoped', async () => {
	expect(parseOAuthRefreshToken('user-1:grant-1:rt1')).toEqual({
		userId: 'user-1',
		grantId: 'grant-1',
	})
	expect(parseOAuthRefreshToken('not-a-token')).toBeNull()
	expect(parseOAuthRefreshToken('user-1:grant-1:')).toBeNull()
	expect(mcpOAuthRefreshFamilySnapshotKey('user-1', 'grant-1')).toBe(
		'derived-cache:v1:mcp-oauth-refresh-family:user-1:grant-1',
	)
	expect(mcpOAuthRefreshFamilyReplayKey('user-1', 'grant-1', 'abc')).toBe(
		'derived-cache:v1:mcp-oauth-refresh-replay:user-1:grant-1:abc',
	)
	expect(await hashOAuthToken('user-1:grant-1:rt1')).toMatch(/^[0-9a-f]{64}$/)
})

test('refresh family returns current tokens on previous reuse and rejects stale replay', () => {
	const nowSeconds = 1_000
	const current = snapshot()
	const family = grant()

	expect(
		decideRefreshFamilyAction({
			presentedHash: 'hash-rt1',
			grant: family,
			snapshot: current,
			replay: null,
			nowSeconds,
		}),
	).toEqual({ kind: 'return-snapshot' })

	expect(
		decideRefreshFamilyAction({
			presentedHash: 'hash-rt1',
			grant: family,
			snapshot: current,
			replay: current,
			nowSeconds,
		}),
	).toEqual({ kind: 'return-replay' })

	expect(
		decideRefreshFamilyAction({
			presentedHash: 'hash-rt2',
			grant: family,
			snapshot: current,
			replay: null,
			nowSeconds,
		}),
	).toEqual({ kind: 'pass-through' })

	expect(
		decideRefreshFamilyAction({
			presentedHash: 'hash-rt1',
			grant: family,
			snapshot: current,
			replay: null,
			nowSeconds: 1_980,
		}),
	).toEqual({ kind: 'refresh-stored-current' })

	expect(
		decideRefreshFamilyAction({
			presentedHash: 'hash-rt0',
			grant: family,
			snapshot: current,
			replay: snapshot({ currentRefreshTokenHash: 'hash-rt2' }),
			nowSeconds,
		}),
	).toEqual({ kind: 'return-replay' })

	expect(
		decideRefreshFamilyAction({
			presentedHash: 'hash-rt1',
			grant: grant({ currentRefreshTokenHash: 'hash-rt3' }),
			snapshot: snapshot({ currentRefreshTokenHash: 'hash-rt2' }),
			replay: snapshot({ currentRefreshTokenHash: 'hash-rt2' }),
			nowSeconds,
		}),
	).toEqual({ kind: 'pass-through' })

	expect(
		decideRefreshFamilyAction({
			presentedHash: 'hash-rt1',
			grant: null,
			snapshot: current,
			replay: current,
			nowSeconds,
		}),
	).toEqual({ kind: 'pass-through' })

	expect(
		decideRefreshFamilyAction({
			presentedHash: 'hash-unknown',
			grant: family,
			snapshot: current,
			replay: null,
			nowSeconds,
		}),
	).toEqual({ kind: 'pass-through' })
})
