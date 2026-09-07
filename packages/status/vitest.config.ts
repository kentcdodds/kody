import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	resolve: {
		alias: {
			'cloudflare:workers': resolve(
				import.meta.dirname,
				'../worker/src/test-support/cloudflare-workers-stub.ts',
			),
		},
	},
	test: {
		environment: 'node',
		include: ['*.node.test.ts'],
	},
})
