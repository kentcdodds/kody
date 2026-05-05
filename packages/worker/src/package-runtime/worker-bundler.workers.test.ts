import {
	createApp,
	createWorker,
	type CreateAppResult,
	type CreateWorkerResult,
} from '@cloudflare/worker-bundler'
import { expect, test } from 'vitest'

function collectModuleText(bundle: CreateWorkerResult) {
	return Object.values(bundle.modules)
		.map((module) => {
			if (typeof module === 'string') return module
			return [module.js, module.cjs, module.text]
				.filter((value): value is string => typeof value === 'string')
				.join('\n')
		})
		.join('\n')
}

function collectAssetText(bundle: CreateAppResult) {
	return Object.values(bundle.assets)
		.filter((asset): asset is string => typeof asset === 'string')
		.join('\n')
}

test(
	'cloudflare worker bundler main entrypoint supports createWorker and createApp locally',
	{ timeout: 20_000 },
	async () => {
		const workerBundle = await createWorker({
			files: {
				'src/worker.ts':
					'export default { fetch() { return new Response("worker-ok") } }\n',
			},
			entryPoint: 'src/worker.ts',
		})

		expect(collectModuleText(workerBundle)).toContain('worker-ok')

		const appBundle = await createApp({
			files: {
				'src/server.ts':
					'export default { fetch() { return new Response("app-ok") } }\n',
				'src/client.ts':
					'document.body.dataset.kodyWorkerBundler = "client-ok"\n',
			},
			server: 'src/server.ts',
			client: 'src/client.ts',
			assets: {
				'/static.txt': 'asset-ok',
			},
		})

		expect(collectModuleText(appBundle)).toContain('app-ok')
		expect(collectAssetText(appBundle)).toContain('client-ok')
		expect(appBundle.assets['/static.txt']).toBe('asset-ok')
	},
)
