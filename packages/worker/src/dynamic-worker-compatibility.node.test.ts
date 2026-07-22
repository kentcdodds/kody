import { expect, test } from 'vitest'
import { createDynamicWorkerCompatibilityOptions } from '#worker/dynamic-worker-compatibility.ts'
import {
	readMainWorkerWranglerCompatibility,
	readMockCloudflareWranglerCompatibility,
} from '#worker/test-support/wrangler-compatibility.ts'

test('dynamic and mock Cloudflare worker compatibility match the main wrangler config', () => {
	const mainWorker = readMainWorkerWranglerCompatibility()
	expect(createDynamicWorkerCompatibilityOptions()).toEqual({
		compatibilityDate: mainWorker.compatibilityDate,
		compatibilityFlags: mainWorker.compatibilityFlags,
	})
	expect(readMockCloudflareWranglerCompatibility()).toEqual(mainWorker)
})
