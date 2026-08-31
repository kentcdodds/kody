/**
 * Calendar-date filename for the signed-in user's memories download.
 * Uses UTC so the same instant produces the same name in every timezone.
 */
export function buildMemoriesExportFilename(now = new Date()) {
	const year = String(now.getUTCFullYear())
	const month = String(now.getUTCMonth() + 1).padStart(2, '0')
	const day = String(now.getUTCDate()).padStart(2, '0')
	return `kody-memories-${year}-${month}-${day}.json`
}
