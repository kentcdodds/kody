type GithubDocsPathOptions = {
	path: string
	localePrefix: RegExp
	apiLabel: string
	localePrefixExample: string
	examplePath: string
	docsUrl: string
}

export function assertGithubDocsPath({
	path,
	localePrefix,
	apiLabel,
	localePrefixExample,
	examplePath,
	docsUrl,
}: GithubDocsPathOptions) {
	const trimmed = path.trim()
	if (!trimmed.startsWith('/')) {
		throw new Error(
			`path must start with \`/\` and must not include a host (for example use \`${examplePath}\`).`,
		)
	}
	if (!localePrefix.test(trimmed)) {
		throw new Error(
			`path must start with a locale ${apiLabel} prefix such as \`${localePrefixExample}\` (see ${docsUrl}).`,
		)
	}
	if (trimmed.includes('..')) {
		throw new Error('path must not contain `..` segments.')
	}
	if (/[\s#]/.test(trimmed)) {
		throw new Error('path contains disallowed characters.')
	}
	if (trimmed.length > 2048) {
		throw new Error('path exceeds maximum length.')
	}
}
