const defaultAppEmbedMaxChars = 8_000

export function buildUiArtifactEmbedText(
	input: {
		title: string
		description: string
		keywords: Array<string>
		runtime: string
		searchText: string | null
		parameters?: Array<{
			name: string
			description: string
			type: string
			required: boolean
			default?: unknown
		}> | null
	},
	maxChars: number = defaultAppEmbedMaxChars,
) {
	const parameterText =
		input.parameters && input.parameters.length > 0
			? [
					'saved app parameters',
					...input.parameters.map((parameter) =>
						[
							parameter.name,
							parameter.type,
							parameter.required ? 'required' : 'optional',
							parameter.description,
							parameter.default !== undefined
								? `default ${JSON.stringify(parameter.default)}`
								: null,
						]
							.filter(Boolean)
							.join(' '),
					),
				].join('\n')
			: null
	const text = [
		input.title,
		input.description,
		input.keywords.join(' '),
		input.runtime,
		'mcp app',
		'ui artifact',
		...(parameterText ? [parameterText] : []),
		...(input.searchText ? [input.searchText] : []),
	].join('\n')
	return text.slice(0, maxChars)
}
