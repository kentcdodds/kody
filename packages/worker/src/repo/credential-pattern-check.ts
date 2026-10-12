import {
	detectLegacyCredentialPatternsCodemod,
	detectLegacyCredentialPatternsCodemodId,
	type LegacyCredentialPattern,
	legacyCredentialPatternFromMessage,
} from '#worker/package-codemods/codemods/0010-detect-legacy-credential-patterns.ts'
import { normalizeRepoWorkspacePath } from './manifest.ts'

const credentialPatternCheckLabel = `codemod ${detectLegacyCredentialPatternsCodemodId}`
const credentialPatternFindingsHeading = `Credential placeholder references (${credentialPatternCheckLabel}, informational; publish is unaffected):`
const credentialPatternFindingsFooter =
	'These references keep working; nothing here needs to change. Labels are described under "Credential slots" in the packages docs.'

/**
 * Optional notes for labels where something better already fits. Keep them
 * suggestions: every listed reference keeps working (ADR 0068).
 */
const credentialPatternHints: Partial<Record<LegacyCredentialPattern, string>> =
	{
		'plain http':
			'plain http: placeholders are filled only in HTTPS requests; use https:// for requests that need them.',
	}

/**
 * Owner-facing codemod 0010: a neutral list of credential placeholder
 * references, as path and pattern label only, with optional hints. Never
 * fails the run.
 */
export function buildCredentialPatternCheck(
	sourceFiles: Record<string, string>,
): { kind: 'credentials'; ok: true; message: string } {
	const patternsByPath = new Map<string, Array<string>>()
	for (const finding of detectLegacyCredentialPatternsCodemod.detect(
		sourceFiles,
		{ packageName: readPackageName(sourceFiles) },
	)) {
		const pattern = legacyCredentialPatternFromMessage(finding.message)
		if (pattern == null) continue
		const path = finding.path ?? 'package'
		patternsByPath.set(path, [...(patternsByPath.get(path) ?? []), pattern])
	}
	if (patternsByPath.size === 0) {
		return {
			kind: 'credentials',
			ok: true,
			message: `No credential placeholder references to list (${credentialPatternCheckLabel}).`,
		}
	}
	const lines = [...patternsByPath].map(
		([path, patterns]) => `- ${path}: ${patterns.join(', ')}`,
	)
	const foundPatterns = new Set([...patternsByPath.values()].flat())
	const hints = Object.entries(credentialPatternHints)
		.filter(([pattern]) => foundPatterns.has(pattern))
		.map(([, hint]) => hint)
	return {
		kind: 'credentials',
		ok: true,
		message: [
			credentialPatternFindingsHeading,
			...lines,
			credentialPatternFindingsFooter,
			...hints,
		].join('\n'),
	}
}

function readPackageName(sourceFiles: Record<string, string>) {
	try {
		const name: unknown = JSON.parse(sourceFiles['package.json'] ?? '').name
		return typeof name === 'string' ? name : ''
	} catch {
		return ''
	}
}

/**
 * The findings for a published file set, or null when there are none. Repo
 * paths are scoped to `sourceRoot` the way `runRepoChecks` reads them.
 */
export function credentialPatternNoticeForFiles(
	files: Record<string, string>,
	sourceRoot = '',
) {
	const root = normalizeRepoWorkspacePath(sourceRoot).replace(/\/+$/, '')
	const scoped = root
		? Object.fromEntries(
				Object.entries(files)
					.filter(([path]) => path.startsWith(`${root}/`))
					.map(([path, content]) => [path.slice(root.length + 1), content]),
			)
		: files
	return credentialPatternFindingsNotice([buildCredentialPatternCheck(scoped)])
}

/** The credentials check message when it found something, for publish output. */
export function credentialPatternFindingsNotice(
	results: ReadonlyArray<{ kind: string; message: string }> | null,
) {
	const check = results?.find((result) => result.kind === 'credentials')
	return check?.message.startsWith(credentialPatternFindingsHeading)
		? check.message
		: null
}
