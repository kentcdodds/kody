import { expect, test } from 'vitest'
import { buildMcpServerInstructions } from './server-instructions.ts'

test('surfaces remote connector identifiers and compacts long descriptions', () => {
	const shortDescription = 'Local-network home automation for lights and media.'
	const longDescription = 'a'.repeat(300)
	const instructions = buildMcpServerInstructions({
		remoteConnectors: [
			{
				name: 'home/default',
				domain: 'remote:home:default',
				description: shortDescription,
			},
			{
				name: 'tools/default',
				domain: 'remote:tools:default',
				description: longDescription,
			},
		],
	})

	expect(instructions).toContain('`home/default`')
	expect(instructions).toContain('`remote:home:default`')
	expect(instructions).toContain(shortDescription)
	expect(instructions).toContain('`tools/default`')
	expect(instructions).toContain('`remote:tools:default`')
	expect(instructions).toContain(`${'a'.repeat(237)}...`)
	expect(instructions).not.toContain(longDescription)
})
