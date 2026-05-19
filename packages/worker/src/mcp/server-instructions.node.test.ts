import { expect, test } from 'vitest'
import { buildMcpServerInstructions } from './server-instructions.ts'

test('formats remote connector summaries with bounded descriptions', () => {
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
	const remoteConnectorSection = instructions
		.split('Connected remote connectors\n')
		.at(1)
		?.split('\n\n')
		.at(0)
	const connectorLines =
		remoteConnectorSection
			?.split('\n')
			.filter((line) => line.startsWith('- `'))
			.filter(Boolean)
			.map((line) => line.trim()) ?? []
	const shortConnectorLine = connectorLines.find((line) =>
		line.includes('`home/default`'),
	)
	const longConnectorLine = connectorLines.find((line) =>
		line.includes('`tools/default`'),
	)
	const longConnectorDescription =
		longConnectorLine?.split(': ').slice(1).join(': ') ?? ''

	expect(connectorLines).toHaveLength(2)
	expect(shortConnectorLine).toMatch(
		/^- `home\/default` \(`remote:home:default`\): /,
	)
	expect(shortConnectorLine).toContain(shortDescription)
	expect(shortConnectorLine).not.toContain('...')
	expect(longConnectorLine).toMatch(
		/^- `tools\/default` \(`remote:tools:default`\): /,
	)
	expect(longConnectorDescription).toMatch(/\.\.\.$/)
	expect(longConnectorLine).not.toContain(longDescription)
	expect(longConnectorDescription).toHaveLength(240)
})
