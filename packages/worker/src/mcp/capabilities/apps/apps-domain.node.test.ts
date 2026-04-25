import { expect, test } from 'vitest'

test('builtin capability domains include apps realtime capabilities', async () => {
	const { builtinDomains } =
		await import('#mcp/capabilities/builtin-domains.ts')
	const appsDomain = builtinDomains.find((domain) => domain.name === 'apps')
	expect(appsDomain).toBeTruthy()
	expect(appsDomain?.capabilities.map((capability) => capability.name)).toEqual(
		expect.arrayContaining([
			'session_emit',
			'session_broadcast',
			'session_list',
		]),
	)
})
