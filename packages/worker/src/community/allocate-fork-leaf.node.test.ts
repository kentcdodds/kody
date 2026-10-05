import { expect, test } from 'vitest'
import {
	communityForkAlternateLeafCandidates,
	resolveCommunityForkAlternateLeaf,
} from './allocate-fork-leaf.ts'

test('communityForkAlternateLeafCandidates suffixes preferred leaf from -2', () => {
	expect(communityForkAlternateLeafCandidates('demo', 3)).toEqual([
		'demo-2',
		'demo-3',
		'demo-4',
	])
})

test('resolveCommunityForkAlternateLeaf skips reserved and taken leaves', async () => {
	expect(
		await resolveCommunityForkAlternateLeaf({
			preferredLeaf: 'discord-gateway',
			reservedLeaves: new Set(['discord-gateway-2']),
			isLeafTaken: async (leaf) => leaf === 'discord-gateway-3',
		}),
	).toBe('discord-gateway-4')

	expect(
		await resolveCommunityForkAlternateLeaf({
			preferredLeaf: 'demo',
			reservedLeaves: new Set(['demo-2']),
			isLeafTaken: async () => true,
			maxAttempts: 2,
		}),
	).toBeNull()
})
