import { expect, test } from 'vitest'
import { computeCommunityBayesianScore } from './service.ts'

test('computeCommunityBayesianScore uses prior mean for unrated listings', () => {
	expect(
		computeCommunityBayesianScore({
			averageStars: null,
			ratingCount: 0,
		}),
	).toBe(3.25)
})

test('computeCommunityBayesianScore ranks higher-rated listings above unrated ones', () => {
	const unrated = computeCommunityBayesianScore({
		averageStars: null,
		ratingCount: 0,
	})
	const highlyRated = computeCommunityBayesianScore({
		averageStars: 5,
		ratingCount: 20,
	})
	const lightlyRated = computeCommunityBayesianScore({
		averageStars: 5,
		ratingCount: 1,
	})

	expect(highlyRated).toBeGreaterThan(unrated)
	expect(highlyRated).toBeGreaterThan(lightlyRated)
	expect(lightlyRated).toBeGreaterThan(unrated)
})

test('computeCommunityBayesianScore pulls sparse ratings toward the prior', () => {
	const sparseFiveStar = computeCommunityBayesianScore({
		averageStars: 5,
		ratingCount: 1,
	})
	expect(sparseFiveStar).toBeCloseTo((3.25 * 5 + 5) / 6, 5)
})
