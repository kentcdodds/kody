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

test('prefers direct oauth reconnect links over generated ui', () => {
	const instructions = buildMcpServerInstructions(null)

	expect(instructions).toContain('OAuth reconnect/refresh requests')
	expect(instructions).toContain('/connect/oauth?provider=<integration-name>')
	expect(instructions).toContain(
		'Do not use `open_generated_ui` just to present those links or buttons',
	)
	expect(instructions).toContain('first inspect the integration metadata')
})
