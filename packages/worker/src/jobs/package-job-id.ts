export const packageJobIdPrefix = 'package-job:'

export function buildPackageJobId(packageId: string, jobName: string) {
	return `${packageJobIdPrefix}${packageId}:${encodeURIComponent(jobName)}`
}

/**
 * Package job ids are `package-job:{packageId}:{encodeURIComponent(jobName)}`.
 * Returns null for ad-hoc jobs or malformed package job ids.
 */
export function packageIdFromJobId(jobId: string): string | null {
	if (!jobId.startsWith(packageJobIdPrefix)) return null
	const rest = jobId.slice(packageJobIdPrefix.length)
	const separatorIndex = rest.indexOf(':')
	if (separatorIndex <= 0) return null
	const packageId = rest.slice(0, separatorIndex).trim()
	return packageId || null
}
