import { expect, test } from 'vitest'
import { createDynamicWorkerCompatibilityOptions } from '#worker/dynamic-worker-compatibility.ts'
import {
	readMainWorkerWranglerCompatibility,
	readMockCloudflareWranglerCompatibility,
} from '#worker/test-support/wrangler-compatibility.ts'

test('dynamic worker compatibility options match the main wrangler config', () => {
	const mainWorker = readMainWorkerWranglerCompatibility()
	expect(createDynamicWorkerCompatibilityOptions()).toEqual({
		compatibilityDate: mainWorker.compatibilityDate,
		compatibilityFlags: mainWorker.compatibilityFlags,
	})
})

test('mock Cloudflare wrangler compatibility matches the main wrangler config', () => {
	expect(readMockCloudflareWranglerCompatibility()).toEqual(
		readMainWorkerWranglerCompatibility(),
	)
})
