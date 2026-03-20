import { expect, test } from 'bun:test'

import { parseArgs, resolveWranglerEnv } from './seed-test-data.ts'

test('parseArgs defaults to the shared seed account credentials', () => {
	const options = parseArgs(['--local'])

	expect(options.email).toBe('me@kentcdodds.com')
	expect(options.username).toBe('me@kentcdodds.com')
	expect(options.password).toBe('iliketwix')
})

test('parseArgs defaults username to provided email when omitted', () => {
	const options = parseArgs(['--email', 'alice@example.com', '--local'])

	expect(options.email).toBe('alice@example.com')
	expect(options.username).toBe('alice@example.com')
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

test('parseArgs defaults the Wrangler env to production', () => {
	const options = parseArgs(['--local'])

	expect(options.env).toBe('production')
})

test('resolveWranglerEnv infers preview from generated config names', () => {
	const env = resolveWranglerEnv({
		config: 'packages/worker/wrangler-preview.generated.json',
	})

	expect(env).toBe('preview')
})
