function toHex(bytes: Uint8Array) {
	return Array.from(bytes)
		.map((value) => value.toString(16).padStart(2, '0'))
		.join('')
}

export async function computeClaudeWidgetDomain(mcpServerUrl: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(mcpServerUrl),
	)
	return `${toHex(new Uint8Array(digest)).slice(0, 32)}.claudemcpcontent.com`
}
