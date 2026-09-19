import { expect, test } from 'vitest'
import {
	SearchRateLimitError,
	searchRateLimitErrorCode,
} from '#worker/search-rate-limit.ts'
import {
	rateLimitStructuredContent,
	toMcpRateLimitMetadata,
} from './rate-limit-metadata.ts'

test('rate limit metadata is only for search abuse denials', () => {
	const denial = new SearchRateLimitError({
		window: 'burst',
		retryAfterSeconds: 60,
		limit: 40,
		plan: 'free',
	})
	expect(toMcpRateLimitMetadata(denial)).toEqual({
		code: searchRateLimitErrorCode,
		window: 'burst',
		retryAfterSeconds: 60,
		limit: 40,
		plan: 'free',
	})
	expect(rateLimitStructuredContent(denial)).toEqual({
		rateLimit: {
			code: searchRateLimitErrorCode,
			window: 'burst',
			retryAfterSeconds: 60,
			limit: 40,
			plan: 'free',
		},
	})
	expect(toMcpRateLimitMetadata(new Error('nope'))).toBeUndefined()
	expect(rateLimitStructuredContent(new Error('nope'))).toEqual({})
})
