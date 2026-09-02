import { createTwoFilesPatch } from 'diff'

export type PublishCommitDiffFileStatus = 'added' | 'removed' | 'modified'

export type PublishCommitDiffFile = {
	path: string
	status: PublishCommitDiffFileStatus
	patch: string | null
}

export type PublishCommitDiff = {
	files: Array<PublishCommitDiffFile>
	omittedCount: number
}

export const publishCommitDiffMaxFiles = 40
const publishCommitDiffMaxFileChars = 80_000

function isPreviewableFileContent(content: string) {
	if (content.includes('\0')) return false
	return content.length <= publishCommitDiffMaxFileChars
}

function comparePaths(left: string, right: string) {
	return left.localeCompare(right)
}

function buildFilePatch(input: {
	path: string
	publishedContent: string
	pendingContent: string
}) {
	if (
		!isPreviewableFileContent(input.publishedContent) ||
		!isPreviewableFileContent(input.pendingContent)
	) {
		return null
	}
	return createTwoFilesPatch(
		`a/${input.path}`,
		`b/${input.path}`,
		input.publishedContent,
		input.pendingContent,
	)
}

export function buildPublishCommitDiff(
	publishedFiles: Record<string, string>,
	pendingFiles: Record<string, string>,
): PublishCommitDiff {
	const paths = new Set([
		...Object.keys(publishedFiles),
		...Object.keys(pendingFiles),
	])
	const changed: Array<PublishCommitDiffFile> = []
	for (const path of [...paths].sort(comparePaths)) {
		const publishedContent = publishedFiles[path]
		const pendingContent = pendingFiles[path]
		if (publishedContent === pendingContent) continue
		if (publishedContent == null) {
			changed.push({
				path,
				status: 'added',
				patch: buildFilePatch({
					path,
					publishedContent: '',
					pendingContent: pendingContent ?? '',
				}),
			})
			continue
		}
		if (pendingContent == null) {
			changed.push({
				path,
				status: 'removed',
				patch: buildFilePatch({
					path,
					publishedContent,
					pendingContent: '',
				}),
			})
			continue
		}
		changed.push({
			path,
			status: 'modified',
			patch: buildFilePatch({
				path,
				publishedContent,
				pendingContent,
			}),
		})
	}
	return {
		files: changed.slice(0, publishCommitDiffMaxFiles),
		omittedCount: Math.max(0, changed.length - publishCommitDiffMaxFiles),
	}
}
