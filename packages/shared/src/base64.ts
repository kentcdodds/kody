export function bytesToBase64(bytes: Uint8Array) {
	let binary = ''
	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}
	return btoa(binary)
}

export function base64ToBytes(value: string) {
	const binary = atob(value)
	return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export function bytesToBase64Url(bytes: Uint8Array) {
	return bytesToBase64(bytes)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '')
}

export function base64UrlToBytes(value: string) {
	const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
	const padded = normalized.padEnd(
		normalized.length + ((4 - (normalized.length % 4)) % 4),
		'=',
	)
	return base64ToBytes(padded)
}

export function utf8ToBase64Url(value: string) {
	return bytesToBase64Url(new TextEncoder().encode(value))
}
