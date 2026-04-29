const markdownSpecialChars = /[\\`*_{}[\]()#+\-.!|>]/g

export function escapeMarkdownText(value: string) {
	return value.replace(markdownSpecialChars, '\\$&').replace(/\r?\n/g, ' ')
}

export function formatUntrustedMarkdownInline(value: string) {
	return escapeMarkdownText(value)
}

export function formatUntrustedMarkdownBlock(value: string) {
	return value
		.split(/\r?\n/)
		.map((line) => `> ${escapeMarkdownText(line)}`)
		.join('\n')
}

export function formatMarkdownInlineCode(value: string) {
	return `\`${value.replace(/`/g, '\\`')}\``
}
