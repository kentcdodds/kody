import {
	detectLegacyCredentialPatternsCodemod,
	detectLegacyCredentialPatternsCodemodId,
	type LegacyCredentialPattern,
	legacyCredentialPatternFromMessage,
} from '#worker/package-codemods/codemods/0010-detect-legacy-credential-patterns.ts'
import { normalizeRepoWorkspacePath } from './manifest.ts'

const credentialPatternCheckLabel = `codemod ${detectLegacyCredentialPatternsCodemodId}`
const credentialPatternFindingsHeading = `Credential placeholder references (${credentialPatternCheckLabel}, informational; publish is unaffected):`
const credentialPatternLabelsDoc =
	'Labels are described under "Credential slots" in the packages docs.'

/**
 * Notes for labels whose requests need a change to work as written, or where
 * a more secure option already fits. Placeholders themselves keep working
 * (ADR 0068), so no note may read as a coming removal.
 */
const credentialPatternNotes: Partial<Record<LegacyCredentialPattern, string>> =
	{
		'plain http':
			'plain http: the fetch gateway refuses a request that carries a placeholder over http://; use https:// for those requests.',
	}

/**
 * Owner-facing codemod 0010: a neutral list of credential placeholder
 * references, as path and pattern label only, with optional notes. Never
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
	const notes = Object.entries(credentialPatternNotes)
		.filter(([pattern]) => foundPatterns.has(pattern))
		.map(([, note]) => note)
	const footer =
		notes.length > 0
			? `These references keep working, except as noted below. ${credentialPatternLabelsDoc}`
			: `These references keep working; nothing here needs to change. ${credentialPatternLabelsDoc}`
	return {
		kind: 'credentials',
		ok: true,
		message: [
			credentialPatternFindingsHeading,
			...lines,
			footer,
			...notes,
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
