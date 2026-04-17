import { expect, test } from 'vitest'

import { parseArgs, resolveWranglerEnv } from './seed-test-data.ts'

test('parseArgs defaults to local mode, production env, and username from email', () => {
	const options = parseArgs(['--email', 'alice@example.com'])

	expect(options.local).toBe(true)
	expect(options.remote).toBe(false)
	expect(options.email).toBe('alice@example.com')
	expect(options.username).toBe('alice@example.com')
	expect(options.env).toBe('production')
})

test('parseArgs keeps explicit username when provided', () => {
	const options = parseArgs([
		'--email',
		'alice@example.com',
		'--username',
		'alice',
		'--local',
	])

	expect(options.email).toBe('alice@example.com')
	expect(options.username).toBe('alice')
})

test('resolveWranglerEnv infers preview from generated config names', () => {
	const env = resolveWranglerEnv({
		config: 'packages/worker/wrangler-preview.generated.json',
	})

	expect(env).toBe('preview')
})
