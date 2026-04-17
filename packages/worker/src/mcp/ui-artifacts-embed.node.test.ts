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
	expect(fullText.split('\n')).toEqual([
		'Spotify OAuth Setup',
		'Connect Spotify to Kody.',
		'mcp app',
		'ui artifact',
		'facet backend',
		'saved app parameters',
		'clientId string required Spotify client id',
		'region string optional Spotify API region default "us"',
	])

	expect(buildUiArtifactEmbedText(input, 24)).toBe(fullText.slice(0, 24))
})
