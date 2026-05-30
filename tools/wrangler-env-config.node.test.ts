import path from 'node:path'
import { expect, test } from 'vitest'

import {
	defaultWranglerConfigPath,
	getDefaultWranglerConfigPath,
	resolveWranglerConfigPath,
} from './wrangler-env-config.ts'

test('wrangler config path helpers default, honor env overrides, and resolve paths', () => {
	expect(getDefaultWranglerConfigPath({})).toBe(defaultWranglerConfigPath)
	expect(
		getDefaultWranglerConfigPath({
			WRANGLER_CONFIG:
				'/workspace/packages/worker/wrangler-production.generated.json',
		}),
	).toBe('/workspace/packages/worker/wrangler-production.generated.json')

	expect(
		resolveWranglerConfigPath(
			'/workspace/packages/worker/wrangler-production.generated.json',
			'/workspace',
		),
	).toBe('/workspace/packages/worker/wrangler-production.generated.json')
	expect(
		resolveWranglerConfigPath(
			'packages/worker/wrangler-production.generated.json',
			'/workspace',
		),
	).toBe(
		path.join(
			'/workspace',
			'packages/worker/wrangler-production.generated.json',
		),
	)
})
