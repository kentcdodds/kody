import path from 'node:path'
import { expect, test } from 'vitest'
import { resolveWranglerConfigPath } from './wrangler-env-config.ts'

test('resolveWranglerConfigPath normalizes relative and absolute config paths', () => {
	const cwd = path.resolve('/workspace/example')
	const expected = path.resolve(cwd, 'wrangler.jsonc')

	expect(resolveWranglerConfigPath('./nested/../wrangler.jsonc', cwd)).toBe(
		expected,
	)
	expect(
		resolveWranglerConfigPath(
			path.join(cwd, 'nested', '..', 'wrangler.jsonc'),
			cwd,
		),
	).toBe(expected)
})
