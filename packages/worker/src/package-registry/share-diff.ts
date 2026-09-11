import { type PackageShareFileChange } from '#universal/package-share.ts'

const maxDiffFileChars = 40_000

function clipFileText(value: string | null): {
	text: string | null
	truncated: boolean
} {
	if (value == null) return { text: null, truncated: false }
	if (value.length <= maxDiffFileChars) {
		return { text: value, truncated: false }
	}
	return {
		text: `${value.slice(0, maxDiffFileChars)}\n\n… truncated for review …`,
		truncated: true,
	}
}

export function diffPublishedSourceFiles(
	accepted: Record<string, string>,
	current: Record<string, string>,
): Array<PackageShareFileChange> {
	const paths = [
		...new Set([...Object.keys(accepted), ...Object.keys(current)]),
	]
	paths.sort((left, right) => left.localeCompare(right))
	const changes: Array<PackageShareFileChange> = []
	for (const path of paths) {
		const acceptedText = accepted[path] ?? null
		const currentText = current[path] ?? null
		if (acceptedText === currentText) continue
		const change =
			acceptedText == null
				? 'added'
				: currentText == null
					? 'removed'
					: 'modified'
		const acceptedClip = clipFileText(acceptedText)
		const currentClip = clipFileText(currentText)
		changes.push({
			path,
			change,
			accepted: acceptedClip.text,
			current: currentClip.text,
			truncated: acceptedClip.truncated || currentClip.truncated,
		})
	}
	return changes
}

export function pinAcknowledgeBlockedByTruncatedReview(
	files: ReadonlyArray<{ truncated: boolean }>,
	switchToFollow: boolean,
) {
	return switchToFollow !== true && files.some((file) => file.truncated)
}
