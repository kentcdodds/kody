export const repoBackedJobModuleStyleErrorMessage =
	'Repo-backed job entrypoints must be execute-compatible async function snippets, not ESM/CommonJS modules.'

export function hasModuleStyleRepoBackedJobEntrypoint(code: string) {
	return (
		/^\s*export\s+/m.test(code) ||
		/\bmodule\.exports\b/.test(code) ||
		/\bexports\.[A-Za-z_$][\w$]*/.test(code)
	)
}
