import { beforeEach } from 'vitest'
import { clearInvokeContractCachesForTests } from '#worker/package-invocations/invoke-contract-cache.ts'

// The invoke contract check caches saved-package rows, source rows, and
// prepared bundle artifacts at module scope (per isolate in production).
// Tests in one file share that module state and routinely reuse fixture ids
// with different data, so reset the caches before every test.
beforeEach(() => {
	clearInvokeContractCachesForTests()
})
