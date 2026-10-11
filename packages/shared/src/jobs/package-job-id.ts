export const packageJobIdPrefix = 'package-job:'

export function buildPackageJobId(packageId: string, jobName: string) {
	return `${packageJobIdPrefix}${packageId}:${encodeURIComponent(jobName)}`
}

/**
 * Package job ids are `package-job:{packageId}:{encodeURIComponent(jobName)}`.
 * Returns null for a malformed id.
 */
export function packageIdFromJobId(jobId: string): string | null {
	if (!jobId.startsWith(packageJobIdPrefix)) return null
	const rest = jobId.slice(packageJobIdPrefix.length)
	const separatorIndex = rest.indexOf(':')
	if (separatorIndex <= 0) return null
	const packageId = rest.slice(0, separatorIndex).trim()
	return packageId || null
}

/** Every job is a package job (ADR 0032); any other id is a bug. */
export function requirePackageIdFromJobId(jobId: string): string {
	const packageId = packageIdFromJobId(jobId)
	if (!packageId) {
		throw new Error(`Job "${jobId}" is not a package job (ADR 0032).`)
	}
	return packageId
}
