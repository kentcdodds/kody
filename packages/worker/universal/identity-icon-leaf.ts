export function identityIconLeafName(name: string) {
	const trimmed = name.trim()
	if (!trimmed) return 'repo'
	if (trimmed.startsWith('@')) {
		const slash = trimmed.lastIndexOf('/')
		if (slash >= 0) {
			const leaf = trimmed.slice(slash + 1).trim()
			if (leaf) return leaf
		}
	}
	return trimmed
}

export function identityIconMonogramLetter(name: string) {
	const leaf = identityIconLeafName(name)
	for (const character of leaf) {
		if (/\p{L}|\p{N}/u.test(character)) return character.toUpperCase()
	}
	return '?'
}
