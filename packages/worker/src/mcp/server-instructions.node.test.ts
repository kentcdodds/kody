import { expect, test } from 'vitest'
import { buildMcpServerInstructions } from './server-instructions.ts'

const secretChatProhibition =
	'Never ask users to paste secrets, tokens, API keys, passwords, or credentials into chat.'

test('keeps secret collection out of chat in base instructions', () => {
	const instructions = buildMcpServerInstructions(null)

	expect(instructions).toContain('/connect/secret')
	expect(instructions).toContain('/connect/oauth')
	expect(instructions).toContain(secretChatProhibition)
})

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
	const connectorLines = instructions
		.split('\n')
		.filter((line) => line.startsWith('- `'))
	const shortConnectorLine = connectorLines.find((line) =>
		line.includes('`home/default`'),
	)
	const longConnectorLine = connectorLines.find((line) =>
		line.includes('`tools/default`'),
	)
	const longConnectorDescription =
		longConnectorLine?.split(': ').slice(1).join(': ') ?? ''

	expect(shortConnectorLine).toContain('home/default')
	expect(shortConnectorLine).toContain('remote:home:default')
	expect(shortConnectorLine).toContain(shortDescription)
	expect(longConnectorLine).toContain('tools/default')
	expect(longConnectorLine).toContain('remote:tools:default')
	expect(longConnectorLine).toContain('...')
	expect(longConnectorLine).not.toContain(longDescription)
	expect(longConnectorDescription.length).toBeLessThanOrEqual(240)
})
