import path from 'node:path'
import { expect, test } from 'vitest'

import {
	defaultWranglerConfigPath,
	getDefaultWranglerConfigPath,
	resolveWranglerConfigPath,
} from './wrangler-env-config.ts'

test('getDefaultWranglerConfigPath defaults to the repository worker config', () => {
	expect(getDefaultWranglerConfigPath({})).toBe(defaultWranglerConfigPath)
})

test('getDefaultWranglerConfigPath honors WRANGLER_CONFIG for deploy wrappers', () => {
	expect(
		getDefaultWranglerConfigPath({
			WRANGLER_CONFIG:
				'/workspace/packages/worker/wrangler-production.generated.json',
		}),
	).toBe('/workspace/packages/worker/wrangler-production.generated.json')
})

test('resolveWranglerConfigPath preserves absolute generated config paths', () => {
	expect(
		resolveWranglerConfigPath(
			'/workspace/packages/worker/wrangler-production.generated.json',
			'/workspace',
		),
	).toBe('/workspace/packages/worker/wrangler-production.generated.json')
})

test('resolveWranglerConfigPath resolves relative config paths from cwd', () => {
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
