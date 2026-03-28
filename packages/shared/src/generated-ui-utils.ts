export function escapeHtmlAttribute(value: string) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
}

export function decodeHtmlAttribute(value: string) {
	return value
		.replaceAll('&quot;', '"')
		.replaceAll('&#39;', "'")
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&amp;', '&')
}

export function isNonNavigableUrl(value: string) {
	const normalizedValue = value.trim().toLowerCase()
	return (
		normalizedValue === '' ||
		normalizedValue.startsWith('#') ||
		normalizedValue.startsWith('//') ||
		normalizedValue.startsWith('about:') ||
		normalizedValue.startsWith('blob:') ||
		normalizedValue.startsWith('data:') ||
		normalizedValue.startsWith('javascript:') ||
		normalizedValue.startsWith('mailto:') ||
		normalizedValue.startsWith('tel:')
	)
}

export function absolutizeUrl(value: string, baseHref: string | null) {
	if (!baseHref || isNonNavigableUrl(value)) {
		return value
	}

	try {
		return new URL(value).toString()
	} catch {}

	try {
		return new URL(value, baseHref).toString()
	} catch {
		return value
	}
}

export function absolutizeSrcset(value: string, baseHref: string | null) {
	return value
		.split(',')
		.map((candidate) => {
			const trimmedCandidate = candidate.trim()
			if (trimmedCandidate.length === 0) {
				return ''
			}

			const [url, ...descriptorParts] = trimmedCandidate.split(/\s+/)
			if (!url) {
				return trimmedCandidate
			}
			return [absolutizeUrl(url, baseHref), ...descriptorParts]
				.filter((part) => part.length > 0)
				.join(' ')
		})
		.join(', ')
}
