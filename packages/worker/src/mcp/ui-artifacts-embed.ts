const defaultAppEmbedMaxChars = 8_000

export function buildUiArtifactEmbedText(
	input: {
		title: string
		description: string
		keywords: Array<string>
		runtime: string
		searchText: string | null
	},
	maxChars: number = defaultAppEmbedMaxChars,
) {
	const text = [
		input.title,
		input.description,
		input.keywords.join(' '),
		input.runtime,
		'mcp app',
		'ui artifact',
		...(input.searchText ? [input.searchText] : []),
	].join('\n')
	return text.slice(0, maxChars)
}
