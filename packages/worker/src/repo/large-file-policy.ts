/**
 * Per-file size policy for repo-backed source (saved packages and jobs).
 *
 * Repos store versioned text source, not large assets: Cloudflare Artifacts
 * rejects push packs above ~32 MiB of decompressed content with a raw HTTP
 * 413, and publish checks materialize the whole source root in Durable
 * Object memory (see `repoChecksSourceMaxTotalBytes` in checks.ts). Gating
 * each file well below those ceilings keeps every failure on a Kody surface
 * with an actionable message instead of an opaque git or memory error.
 *
 * Files are never rewritten into pointers opaquely — the gate rejects with
 * guidance and the user decides where the large file lives.
 */
export const maxRepoSourceFileBytes = 10 * 1024 * 1024

const encoder = new TextEncoder()

export function measureRepoSourceFileBytes(content: string) {
	return encoder.encode(content).byteLength
}

function formatMiB(bytes: number) {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function formatBytes(bytes: number) {
	return `${bytes.toLocaleString('en-US')} bytes (${formatMiB(bytes)})`
}

/**
 * Stable phrase used to recognize large-file rejections after their message
 * crosses the Durable Object RPC boundary (subclass identity does not
 * survive RPC). `isRepoLargeFileMessage` and MCP observability depend on it.
 */
const repoLargeFileMessagePhrase = 'per-file limit for repo-backed source'

export function isRepoLargeFileMessage(message: string) {
	return message.includes(repoLargeFileMessagePhrase)
}

export function buildRepoLargeFileMessage(input: {
	path: string
	byteLength: number
}) {
	return (
		`"${input.path}" is ${formatBytes(input.byteLength)}, which is over the ` +
		`${formatBytes(maxRepoSourceFileBytes)} ${repoLargeFileMessagePhrase}. ` +
		'Repos store versioned source and small assets, not large files. ' +
		'Host the file on storage you manage (for example Cloudflare R2, Amazon S3, ' +
		'Dropbox, or Google Drive) and commit a small link or pointer file instead.'
	)
}

/**
 * Returns the first oversized file entry, or null when every file is within
 * the per-file limit. Callers decide how to surface the failure (check
 * result, caller error, or RPC error) but must use
 * `buildRepoLargeFileMessage` for the user-facing text.
 */
export function findOversizedRepoSourceFile(
	files: Iterable<readonly [path: string, content: string]>,
) {
	for (const [path, content] of files) {
		const byteLength = measureRepoSourceFileBytes(content)
		if (byteLength > maxRepoSourceFileBytes) {
			return { path, byteLength }
		}
	}
	return null
}
