export function normalizeRepoWorkspacePath(path: string) {
	return path.trim().replace(/^\/+/, '')
}
