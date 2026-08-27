import { expect, test, vi } from 'vitest'

import {
	ensureNxCacheResources,
	NX_CACHE_R2_BUCKET_NAME,
	nxCacheLifecyclePolicy,
} from './nx-cache-resources.ts'
import { ensureR2Bucket, ensureR2BucketLifecycle } from './resource-utils.ts'

vi.mock('./resource-utils.ts', () => ({
	ensureR2Bucket: vi.fn<
		(input: { name: string; dryRun: boolean }) => {
			name: string
		}
	>((input) => ({ name: input.name })),
	ensureR2BucketLifecycle: vi.fn<
		(input: {
			name: string
			policy: typeof nxCacheLifecyclePolicy
			dryRun: boolean
		}) => {
			name: string
			policy: typeof nxCacheLifecyclePolicy
		}
	>((input) => ({ name: input.name, policy: input.policy })),
}))

test('ensureNxCacheResources creates the shared R2 bucket and applies 14-day expiry', () => {
	expect(ensureNxCacheResources({ dryRun: true })).toEqual({
		name: NX_CACHE_R2_BUCKET_NAME,
		lifecycle: nxCacheLifecyclePolicy,
	})
	expect(ensureR2Bucket).toHaveBeenCalledWith({
		name: 'kody-nx-cache',
		dryRun: true,
	})
	expect(ensureR2BucketLifecycle).toHaveBeenCalledWith({
		name: 'kody-nx-cache',
		policy: nxCacheLifecyclePolicy,
		dryRun: true,
	})
})
