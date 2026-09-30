/**
 * Git pkt-line helpers for smart HTTP advertisements.
 * isomorphic-git keeps pkt-line internals private; keep a small local encoder.
 */

const flushPkt = '0000'
const textEncoder = new TextEncoder()

export function encodeGitPktLine(payload: string): string {
	const length = textEncoder.encode(payload).byteLength + 4
	if (length > 0xffff) {
		throw new Error(`Git pkt-line payload too large (${length} bytes).`)
	}
	return `${length.toString(16).padStart(4, '0')}${payload}`
}

export function encodeGitFlushPkt(): string {
	return flushPkt
}

/**
 * Build a protocol-v1 `git-upload-pack` advertisement that only exposes one
 * immutable snapshot commit on HEAD and the default branch.
 */
export function buildUploadPackAdvertisement(input: {
	commit: string
	defaultBranch: string
	agent?: string
}): Uint8Array {
	const commit = input.commit.trim().toLowerCase()
	if (!/^[0-9a-f]{40}$/.test(commit)) {
		throw new Error('Published snapshot commit must be a 40-character SHA.')
	}
	const branch = input.defaultBranch.trim() || 'main'
	const headRef = `refs/heads/${branch}`
	const capabilities = [
		'multi_ack',
		'thin-pack',
		'side-band',
		'side-band-64k',
		'ofs-delta',
		'shallow',
		'deepen-since',
		'deepen-not',
		'deepen-relative',
		'no-progress',
		'include-tag',
		'multi_ack_detailed',
		'allow-tip-sha1-in-want',
		'allow-reachable-sha1-in-want',
		'no-done',
		`symref=HEAD:${headRef}`,
		`agent=${input.agent ?? 'kody'}`,
	].join(' ')

	const body =
		encodeGitPktLine('# service=git-upload-pack\n') +
		encodeGitFlushPkt() +
		encodeGitPktLine(`${commit} HEAD\0${capabilities}\n`) +
		encodeGitPktLine(`${commit} ${headRef}\n`) +
		encodeGitFlushPkt()

	return textEncoder.encode(body)
}

/**
 * Rewrite an upstream upload-pack advertisement so every advertised ref points
 * at the published snapshot commit, while preserving the upstream capability
 * list from the first ref packet (so later upload-pack negotiation matches).
 * Falls back to a generated advertisement when the upstream body is unusable.
 */
export function rewriteUploadPackAdvertisement(input: {
	upstreamBody: Uint8Array
	commit: string
	defaultBranch: string
	agent?: string
}): Uint8Array {
	const commit = input.commit.trim().toLowerCase()
	if (!/^[0-9a-f]{40}$/.test(commit)) {
		throw new Error('Published snapshot commit must be a 40-character SHA.')
	}
	const branch = input.defaultBranch.trim() || 'main'
	const headRef = `refs/heads/${branch}`
	const text = new TextDecoder().decode(input.upstreamBody)
	const packets = splitGitPktLines(text)
	let capabilities: string | null = null
	for (const packet of packets) {
		if (packet === null) continue
		if (packet.startsWith('# service=')) continue
		const nullIndex = packet.indexOf('\0')
		if (nullIndex === -1) continue
		const rest = packet.slice(nullIndex + 1).replace(/\n$/, '')
		if (rest.length > 0) {
			capabilities = rest
				.split(' ')
				.filter((part) => part.length > 0 && !part.startsWith('symref='))
				.concat([`symref=HEAD:${headRef}`, `agent=${input.agent ?? 'kody'}`])
				.join(' ')
			break
		}
	}
	if (!capabilities) {
		return buildUploadPackAdvertisement(input)
	}

	const body =
		encodeGitPktLine('# service=git-upload-pack\n') +
		encodeGitFlushPkt() +
		encodeGitPktLine(`${commit} HEAD\0${capabilities}\n`) +
		encodeGitPktLine(`${commit} ${headRef}\n`) +
		encodeGitFlushPkt()
	return textEncoder.encode(body)
}

function splitGitPktLines(body: string): Array<string | null> {
	const packets: Array<string | null> = []
	let offset = 0
	while (offset + 4 <= body.length) {
		const lengthHex = body.slice(offset, offset + 4)
		if (lengthHex === flushPkt) {
			packets.push(null)
			offset += 4
			continue
		}
		const length = Number.parseInt(lengthHex, 16)
		if (!Number.isFinite(length) || length < 4) break
		const payload = body.slice(offset + 4, offset + length)
		packets.push(payload)
		offset += length
	}
	return packets
}
