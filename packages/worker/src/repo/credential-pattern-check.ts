import {
	detectLegacyCredentialPatternsCodemod,
	detectLegacyCredentialPatternsCodemodId,
	type LegacyCredentialPattern,
	legacyCredentialPatternFromMessage,
} from '#worker/package-codemods/codemods/0010-detect-legacy-credential-patterns.ts'
import {
	scanPackageCredentials,
	type CredentialReference,
} from '#worker/credentials/credential-inventory-scan.ts'
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

type CredentialTypeHint = 'inject' | 'oauth' | 'url' | 'login' | 'signing'

/**
 * Optional suggestions, one per credential type that fits a placement the
 * scan found (ADR 0068). They describe a choice, never a problem: nothing is
 * suggested for a placement no type fits, and placeholders keep working.
 */
const credentialTypeHints: Record<CredentialTypeHint, string> = {
	inject:
		"Header, query, or basic auth placeholders: a Key with an inject (credentialUpdate) can be opened with credential(key), and its client places the value and sends it only to the Key's hosts.",
	oauth:
		'Integration token headers: credential(key) for an OAuth connection sends Authorization: Bearer and refreshes the token for you.',
	url: 'Path or whole-URL placeholders: a url credential (secretSet kind "url") holds the whole URL, and its client fetches it without the URL entering code.',
	login:
		'Password or token exchange bodies: a login credential (secretSet kind "login") runs the exchange on the host and places the session token.',
	signing:
		'Signing (secretJwtSign or signature key material): a signing credential (secretSet kind "signing") signs through credential(key).sign() without exposing the key.',
}

const credentialTypeHintsHeading =
	'Optional, if you want a scoped credential type for these (ADR 0068):'

const loginBodyFieldPattern = /pass(?:word|wd)?|refresh_?token|client_?secret/i

function credentialTypeHintFor(
	reference: CredentialReference,
): CredentialTypeHint | null {
	const { placement } = reference
	switch (placement.type) {
		case 'header':
			return reference.nameKind === 'integration' ? 'oauth' : 'inject'
		case 'query':
		case 'basic':
			return reference.nameKind === 'integration' ? null : 'inject'
		case 'path':
		case 'url':
			return 'url'
		case 'body':
			return placement.endpoint === 'login' ||
				(placement.field != null && loginBodyFieldPattern.test(placement.field))
				? 'login'
				: null
		case 'signing':
			return 'signing'
		case 'header-custom':
		case 'binding':
		case 'other':
			return null
		default: {
			const exhaustive: never = placement
			throw new Error(`Unhandled placement: ${String(exhaustive)}`)
		}
	}
}

function credentialTypeHintLines(sourceFiles: Record<string, string>) {
	let scan: ReturnType<typeof scanPackageCredentials>
	try {
		scan = scanPackageCredentials({ files: sourceFiles, slots: undefined })
	} catch {
		// Hints are optional; a scan failure must never touch the check or publish.
		return []
	}
	const found = new Set<CredentialTypeHint>()
	for (const reference of scan.references) {
		const hint = credentialTypeHintFor(reference)
		if (hint) found.add(hint)
	}
	if (scan.jwtSignCalls > 0) found.add('signing')
	const hints = (Object.keys(credentialTypeHints) as Array<CredentialTypeHint>)
		.filter((hint) => found.has(hint))
		.map((hint) => `- ${credentialTypeHints[hint]}`)
	return hints.length > 0 ? [credentialTypeHintsHeading, ...hints] : []
}

/**
 * Owner-facing codemod 0010: a neutral list of credential placeholder
 * references, as path and pattern label only, with optional notes and
 * optional credential type hints. Never fails the run.
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
			...credentialTypeHintLines(sourceFiles),
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
