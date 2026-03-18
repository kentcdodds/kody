export function buildAuthLink(path: string, redirectTo: string | null) {
	if (!redirectTo) return path
	const params = new URLSearchParams({ redirectTo })
	return `${path}?${params.toString()}`
}
