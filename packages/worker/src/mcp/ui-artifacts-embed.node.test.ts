import { expect, test } from 'vitest'
import { buildUiArtifactEmbedText } from './ui-artifacts-embed.ts'

test('buildUiArtifactEmbedText summarizes searchable app metadata and truncates long embeds', () => {
	const input = {
		title: 'Spotify OAuth Setup',
		description: 'Connect Spotify to Kody.',
		hasServerCode: true,
		parameters: [
			{
				name: 'clientId',
				description: 'Spotify client id',
				type: 'string',
				required: true,
			},
			{
				name: 'region',
				description: 'Spotify API region',
				type: 'string',
				required: false,
				default: 'us',
			},
		],
	}

	const fullText = buildUiArtifactEmbedText(input)
	const lines = fullText.split('\n')
	expect(lines.slice(0, 5)).toEqual([
		'Spotify OAuth Setup',
		'Connect Spotify to Kody.',
		'mcp app',
		'ui artifact',
		'facet backend',
	])
	expect(lines).toContain('package app parameters')
	expect(
		lines.some((line) => line.startsWith('clientId string required')),
	).toBe(true)
	expect(lines.some((line) => line.includes('region string optional'))).toBe(
		true,
	)
	expect(lines.some((line) => line.includes('default "us"'))).toBe(true)

	expect(buildUiArtifactEmbedText(input, 24)).toBe(fullText.slice(0, 24))
})
