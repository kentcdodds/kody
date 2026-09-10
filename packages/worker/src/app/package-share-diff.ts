import { type PackageShareFileChange } from '#universal/package-share.ts'

const maxDiffFileChars = 40_000

function clipFileText(value: string | null) {
	if (value == null) return null
	if (value.length <= maxDiffFileChars) return value
	return `${value.slice(0, maxDiffFileChars)}\n\n… truncated for review …`
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
		changes.push({
			path,
			change,
			accepted: clipFileText(acceptedText),
			current: clipFileText(currentText),
		})
	}
	return changes
}
