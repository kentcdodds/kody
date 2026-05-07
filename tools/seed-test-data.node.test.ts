import { expect, test } from 'vitest'

import { parseArgs, resolveWranglerEnv } from './seed-test-data.ts'

test('seed data arg parsing keeps the default local workflow while honoring overrides', () => {
	const defaultOptions = parseArgs(['--email', 'alice@example.com'])
	expect(defaultOptions.local).toBe(true)
	expect(defaultOptions.remote).toBe(false)
	expect(defaultOptions.email).toBe('alice@example.com')
	expect(defaultOptions.username).toBe('alice@example.com')
	expect(defaultOptions.env).toBe('production')

	const explicitUsernameOptions = parseArgs([
		'--email',
		'alice@example.com',
		'--username',
		'alice',
		'--local',
	])
	expect(explicitUsernameOptions.email).toBe('alice@example.com')
	expect(explicitUsernameOptions.username).toBe('alice')

	expect(
		resolveWranglerEnv({
			config: 'packages/worker/wrangler-preview.generated.json',
		}),
	).toBe('preview')
})
