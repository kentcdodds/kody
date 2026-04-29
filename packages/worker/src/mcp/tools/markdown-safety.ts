const markdownSpecialChars = /[\\`*_{}[\]()#+\-.!|>]/g

export function escapeMarkdownText(value: string) {
	return value.replace(markdownSpecialChars, '\\$&').replace(/\r?\n/g, ' ')
}

export function formatMarkdownInlineCode(value: string) {
	if (!value.includes('`')) return `\`${value}\``
	const backtickRuns = value.match(/`+/g) ?? []
	const delimiter = '`'.repeat(
		Math.max(...backtickRuns.map((run) => run.length + 1)),
	)
	return `${delimiter} ${value} ${delimiter}`
}
