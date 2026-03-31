import { expect, test } from 'vitest'
import { buildUiArtifactEmbedText } from './ui-artifacts-embed.ts'

test('buildUiArtifactEmbedText keeps parameter hints', () => {
	const text = buildUiArtifactEmbedText({
		title: 'Spotify OAuth Setup',
		description: 'Connect Spotify to Kody.',
		runtime: 'html',
		parameters: [
			{
				name: 'clientId',
				description: 'Spotify client id',
				type: 'string',
				required: true,
			},
		],
	})

	expect(text).toContain('Spotify OAuth Setup')
	expect(text).toContain('Connect Spotify to Kody.')
	expect(text).toContain('saved app parameters')
	expect(text).toContain('clientId string required Spotify client id')
})
