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
 *
 * Separately, `@cloudflare/shell` `applyTextEdits` refuses to emit a unified
 * diff when either side exceeds `maxRepoSourceFileDiffLines` (EFBIG). A file
 * can pass the byte gate and still hit that line limit — preflight with
 * `buildRepoDiffTooLargeMessage` so agents see an actionable denial instead
 * of the raw shell error. A future write-without-full-diff path in the shell
 * (or a Kody bypass) could lift this for agents; until then the line gate
 * mirrors the shell ceiling.
 */
export const maxRepoSourceFileBytes = 10 * 1024 * 1024

/**
 * Mirrors `@cloudflare/shell` `MAX_DIFF_LINES` (throws
 * `EFBIG: content too large for diff (max 10000 lines)`).
 */
export const maxRepoSourceFileDiffLines = 10_000

const encoder = new TextEncoder()

export function measureRepoSourceFileBytes(content: string) {
	return encoder.encode(content).byteLength
}

/**
 * Line count matching `@cloudflare/shell` diff sizing (`split('\n').length`).
 */
export function measureRepoSourceFileLines(content: string) {
	return content.split('\n').length
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

/**
 * Stable phrase for diff-line-limit rejections. Also match the raw
 * `@cloudflare/shell` EFBIG wording so in-flight events classify correctly.
 */
const repoDiffTooLargeMessagePhrase =
	'line limit for repo session unified diffs'

const repoCloudflareShellDiffTooLargePhrase = 'too large for diff'

export function isRepoLargeFileMessage(message: string) {
	return message.includes(repoLargeFileMessagePhrase)
}

export function isRepoDiffTooLargeMessage(message: string) {
	return (
		message.includes(repoDiffTooLargeMessagePhrase) ||
		(message.includes('EFBIG') &&
			message.includes(repoCloudflareShellDiffTooLargePhrase)) ||
		(message.includes(repoCloudflareShellDiffTooLargePhrase) &&
			message.includes('max 10000 lines'))
	)
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

export function buildRepoDiffTooLargeMessage(input: {
	path: string
	lineCount: number
}) {
	return (
		`"${input.path}" has ${input.lineCount.toLocaleString('en-US')} lines, ` +
		`which is over the ${maxRepoSourceFileDiffLines.toLocaleString('en-US')}-line ` +
		`${repoDiffTooLargeMessagePhrase}. ` +
		'Repo session edits cannot emit unified diffs for files over that limit. ' +
		'Split the file into smaller sources, store large blobs outside the repo ' +
		'(for example Cloudflare R2, Amazon S3, Dropbox, or Google Drive), ' +
		'or write smaller chunks.'
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
