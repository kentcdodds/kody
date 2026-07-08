export function fnv1a32(input: string) {
	let hash = 2_166_136_261
	for (let index = 0; index < input.length; index += 1) {
		hash ^= input.charCodeAt(index)
		hash = Math.imul(hash, 16_777_619)
	}
	return hash >>> 0
}

export function fnv1a32Hex(input: string) {
	return fnv1a32(input).toString(16).padStart(8, '0')
}
