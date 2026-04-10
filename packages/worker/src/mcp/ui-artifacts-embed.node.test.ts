import { expect, test } from 'vitest'
import { buildUiArtifactEmbedText } from './ui-artifacts-embed.ts'

test('buildUiArtifactEmbedText includes parameter names', () => {
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

	expect(text).toContain('clientId')
})
