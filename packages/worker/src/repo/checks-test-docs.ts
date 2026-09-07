export const defaultRequiredPackageDocs = {
	'README.md': '# Test package\n\n## Intent\n\nTest package.\n',
	'AGENTS.md': '# Agents\n\nImport the root export and smoke-test it.\n',
} as const

export function withRequiredPackageDocs(files: Map<string, string>) {
	const packageJsonPath = [...files.keys()].find(
		(path) => path === 'package.json' || path.endsWith('/package.json'),
	)
	const prefix =
		packageJsonPath && packageJsonPath.includes('/')
			? packageJsonPath.slice(0, packageJsonPath.lastIndexOf('/') + 1)
			: ''
	const hasReadme = [...files.keys()].some(
		(path) => path.split('/').pop()?.toLowerCase() === 'readme.md',
	)
	const hasAgents = [...files.keys()].some(
		(path) => path.split('/').pop()?.toLowerCase() === 'agents.md',
	)
	if (!hasReadme) {
		files.set(`${prefix}README.md`, defaultRequiredPackageDocs['README.md'])
	}
	if (!hasAgents) {
		files.set(`${prefix}AGENTS.md`, defaultRequiredPackageDocs['AGENTS.md'])
	}
	return files
}
