import { expect, test, vi } from 'vitest'

import {
	ensureNxCacheResources,
	NX_CACHE_R2_BUCKET_NAME,
} from './nx-cache-resources.ts'
import { ensureR2Bucket } from './resource-utils.ts'

vi.mock('./resource-utils.ts', () => ({
	ensureR2Bucket: vi.fn<
		(input: { name: string; dryRun: boolean }) => {
			name: string
			dryRun: boolean
		}
	>((input) => input),
}))

test('ensureNxCacheResources creates the shared R2 bucket', () => {
	expect(ensureNxCacheResources({ dryRun: true })).toEqual({
		name: NX_CACHE_R2_BUCKET_NAME,
		dryRun: true,
	})
	expect(ensureR2Bucket).toHaveBeenCalledWith({
		name: 'kody-nx-cache',
		dryRun: true,
	})
})
