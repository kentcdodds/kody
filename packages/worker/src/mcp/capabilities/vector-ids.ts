const textEncoder = new TextEncoder()

export const vectorizeMaxIdBytes = 64

const sha256InitialHash = [
	0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
	0x1f83d9ab, 0x5be0cd19,
] as const

const sha256RoundConstants = [
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
	0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
	0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
	0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
	0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
	0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const

function utf8ByteLength(value: string) {
	return textEncoder.encode(value).length
}

function rightRotate(value: number, bits: number) {
	return (value >>> bits) | (value << (32 - bits))
}

function sha256Bytes(input: Uint8Array) {
	const bitLength = BigInt(input.length) * 8n
	const paddedLength = Math.ceil((input.length + 9) / 64) * 64
	const padded = new Uint8Array(paddedLength)
	padded.set(input)
	padded[input.length] = 0x80
	for (let index = 0; index < 8; index += 1) {
		padded[paddedLength - 1 - index] = Number(
			(bitLength >> BigInt(index * 8)) & 0xffn,
		)
	}

	const words = new Uint32Array(64)
	let hash0: number = sha256InitialHash[0]
	let hash1: number = sha256InitialHash[1]
	let hash2: number = sha256InitialHash[2]
	let hash3: number = sha256InitialHash[3]
	let hash4: number = sha256InitialHash[4]
	let hash5: number = sha256InitialHash[5]
	let hash6: number = sha256InitialHash[6]
	let hash7: number = sha256InitialHash[7]

	for (let offset = 0; offset < padded.length; offset += 64) {
		for (let index = 0; index < 16; index += 1) {
			const wordOffset = offset + index * 4
			words[index] =
				((padded[wordOffset]! << 24) |
					(padded[wordOffset + 1]! << 16) |
					(padded[wordOffset + 2]! << 8) |
					padded[wordOffset + 3]!) >>>
				0
		}
		for (let index = 16; index < 64; index += 1) {
			const s0 =
				rightRotate(words[index - 15]!, 7) ^
				rightRotate(words[index - 15]!, 18) ^
				(words[index - 15]! >>> 3)
			const s1 =
				rightRotate(words[index - 2]!, 17) ^
				rightRotate(words[index - 2]!, 19) ^
				(words[index - 2]! >>> 10)
			words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0
		}

		let a = hash0
		let b = hash1
		let c = hash2
		let d = hash3
		let e = hash4
		let f = hash5
		let g = hash6
		let h = hash7

		for (let index = 0; index < 64; index += 1) {
			const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)
			const choice = (e & f) ^ (~e & g)
			const temp1 =
				(h + s1 + choice + sha256RoundConstants[index]! + words[index]!) >>> 0
			const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)
			const majority = (a & b) ^ (a & c) ^ (b & c)
			const temp2 = (s0 + majority) >>> 0

			h = g
			g = f
			f = e
			e = (d + temp1) >>> 0
			d = c
			c = b
			b = a
			a = (temp1 + temp2) >>> 0
		}

		hash0 = (hash0 + a) >>> 0
		hash1 = (hash1 + b) >>> 0
		hash2 = (hash2 + c) >>> 0
		hash3 = (hash3 + d) >>> 0
		hash4 = (hash4 + e) >>> 0
		hash5 = (hash5 + f) >>> 0
		hash6 = (hash6 + g) >>> 0
		hash7 = (hash7 + h) >>> 0
	}

	const output = new Uint8Array(32)
	const hashes = [hash0, hash1, hash2, hash3, hash4, hash5, hash6, hash7]
	for (let index = 0; index < hashes.length; index += 1) {
		const value = hashes[index]!
		const offset = index * 4
		output[offset] = value >>> 24
		output[offset + 1] = value >>> 16
		output[offset + 2] = value >>> 8
		output[offset + 3] = value
	}
	return output
}

function bytesToHex(bytes: Uint8Array) {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
		'',
	)
}

function sha256Hex(value: string) {
	return bytesToHex(sha256Bytes(textEncoder.encode(value)))
}

export function buildLengthSafeVectorId(input: {
	prefix: string
	rawId: string
}) {
	const passthrough = `${input.prefix}_${input.rawId}`
	if (utf8ByteLength(passthrough) <= vectorizeMaxIdBytes) {
		return passthrough
	}

	const digestPrefix = `${input.prefix}_sha256:`
	const digestCharacters = vectorizeMaxIdBytes - utf8ByteLength(digestPrefix)
	if (digestCharacters <= 0) {
		throw new Error(
			`Vectorize id prefix "${digestPrefix}" exceeds ${vectorizeMaxIdBytes} bytes.`,
		)
	}
	return `${digestPrefix}${sha256Hex(input.rawId).slice(0, digestCharacters)}`
}

export function getRawIdFromPassthroughVectorId(input: {
	prefix: string
	vectorId: string
}) {
	const passthroughPrefix = `${input.prefix}_`
	const digestPrefix = `${input.prefix}_sha256:`
	if (!input.vectorId.startsWith(passthroughPrefix)) return null
	if (input.vectorId.startsWith(digestPrefix)) return null
	return input.vectorId.slice(passthroughPrefix.length)
}
