import { isExecutedDirectly } from '../node-runtime.ts'
import { ensureR2Bucket } from './resource-utils.ts'

export const NX_CACHE_R2_BUCKET_NAME = 'kody-nx-cache'

export function ensureNxCacheResources(options: { dryRun: boolean }) {
	return ensureR2Bucket({
		name: NX_CACHE_R2_BUCKET_NAME,
		dryRun: options.dryRun,
	})
}

if (isExecutedDirectly(import.meta.url)) {
	ensureNxCacheResources({
		dryRun: process.argv.includes('--dry-run'),
	})
}
