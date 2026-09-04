import { expect, test } from 'vitest'
import { originViteDeployArgs, originViteWranglerConfigPath } from './deploy.ts'

test('origin Vite deploy always points Wrangler at the generated SSR config', () => {
	expect(originViteWranglerConfigPath).toBe('dist/ssr/wrangler.json')
	expect(
		originViteDeployArgs([
			'--config',
			'packages/worker/wrangler-production.generated.json',
			'--var',
			'APP_COMMIT_SHA:abc',
		]),
	).toEqual([
		'deploy',
		'--config',
		'dist/ssr/wrangler.json',
		'--var',
		'APP_COMMIT_SHA:abc',
	])
})
