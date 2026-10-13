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
import {
	type PackageCredentialKind,
	type PackageCredentialSlot,
	packageCredentialKindValues,
} from '#worker/package-registry/types.ts'
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

/**
 * Whole field names only. An unanchored `pass` also matches `compass`.
 * `refresh_token` / `client_secret` stay the same names, including camelCase.
 */
const loginBodyFieldPattern =
	/^(?:pass(?:word|wd)?|refresh_?token|client_?secret)$/i

/** Codemod 0010 lists a secret name unless this slot kind is declared for it. */
const declaredSlotKindByNameKind = {
	secret: 'secret',
	integration: 'oauth',
} as const satisfies Record<CredentialReference['nameKind'], 'secret' | 'oauth'>

const packageCredentialKinds: ReadonlySet<string> = new Set(
	packageCredentialKindValues,
)

function credentialTypeHintFor(
	reference: CredentialReference,
): CredentialTypeHint | null {
	const { placement } = reference
	switch (placement.type) {
		case 'header':
			// The OAuth client always sends Authorization: Bearer. Another
			// header or scheme would change the request, so it is not a fit.
			if (reference.nameKind === 'integration') {
				return placement.name === 'authorization' &&
					placement.format === 'Bearer {value}'
					? 'oauth'
					: null
			}
			return 'inject'
		case 'query':
			return reference.nameKind === 'integration' ? null : 'inject'
		case 'basic':
			// `{{secret-basic:username=…,password=…}}` is two secrets. A Key
			// basic inject holds one value and a literal, so neither name fits.
			return null
		case 'path':
		case 'url':
			return 'url'
		case 'body': {
			// A login client exchanges a password or token, then sends the
			// session. A password field on some other request does not fit,
			// and neither does an unrelated field on a login URL. When the
			// scanner nulls a field that matched the secret name (for example
			// `password: '{{secret:PASSWORD}}'`), fall back to the name.
			if (placement.endpoint !== 'login') return null
			const field = placement.field ?? reference.name
			return loginBodyFieldPattern.test(field) ? 'login' : null
		}
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
		scan = scanPackageCredentials({
			files: sourceFiles,
			slots: readDeclaredCredentialSlots(sourceFiles['package.json']),
		})
	} catch {
		// Hints are optional; a scan failure must never touch the check or publish.
		return []
	}
	const declared = new Set(
		scan.slots.map((slot) => declaredSlotKey(slot.kind, slot.name)),
	)
	const found = new Set<CredentialTypeHint>()
	for (const reference of scan.references) {
		if (referenceNamesDeclaredSlot(reference, declared)) continue
		const hint = credentialTypeHintFor(reference)
		if (hint) found.add(hint)
	}
	// secretJwtSign takes a secret name string, not a {{secret:…}} placeholder.
	// Suggest signing only when that name is not already a declared secret slot.
	for (const name of scan.jwtSignSecretNames) {
		if (declared.has(declaredSlotKey('secret', name))) continue
		found.add('signing')
		break
	}
	// Calls whose secret name is not a string literal still need a hint.
	if (scan.jwtSignCalls > scan.jwtSignSecretNames.length) {
		found.add('signing')
	}
	const hints = (Object.keys(credentialTypeHints) as Array<CredentialTypeHint>)
		.filter((hint) => found.has(hint))
		.map((hint) => `- ${credentialTypeHints[hint]}`)
	return hints.length > 0 ? [credentialTypeHintsHeading, ...hints] : []
}

function declaredSlotKey(kind: string, name: string) {
	return `${kind}:${name}`
}

/**
 * True when codemod 0010 would omit this placeholder because it already names
 * a declared slot of the matching kind. Hints follow that list: a type with
 * no visible reference is not a suggestion.
 */
function referenceNamesDeclaredSlot(
	reference: CredentialReference,
	declared: ReadonlySet<string>,
) {
	const kind = declaredSlotKindByNameKind[reference.nameKind]
	return declared.has(declaredSlotKey(kind, reference.name))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isPackageCredentialKind(
	value: string,
): value is PackageCredentialKind {
	return packageCredentialKinds.has(value)
}

/**
 * Declared `kody.credentials` slots, read the same way codemod 0010 does:
 * any plain object with a known kind counts, even when publish would still
 * ask for a description. Passed into the placement scan so hint filtering
 * uses the slots the scan recorded.
 */
function readDeclaredCredentialSlots(
	manifestSource: string | undefined,
): Record<string, PackageCredentialSlot> | undefined {
	if (manifestSource == null) return undefined
	let parsed: unknown
	try {
		parsed = JSON.parse(manifestSource)
	} catch {
		return undefined
	}
	if (!isPlainObject(parsed) || !isPlainObject(parsed.kody)) return undefined
	const credentials = parsed.kody.credentials
	if (!isPlainObject(credentials)) return undefined
	const slots: Record<string, PackageCredentialSlot> = {}
	for (const [name, slot] of Object.entries(credentials)) {
		const declared = credentialSlotFromManifest(slot)
		if (declared) slots[name] = declared
	}
	return Object.keys(slots).length > 0 ? slots : undefined
}

function credentialSlotFromManifest(
	slot: unknown,
): PackageCredentialSlot | null {
	if (!isPlainObject(slot) || typeof slot.kind !== 'string') return null
	if (!isPackageCredentialKind(slot.kind)) return null
	const description =
		typeof slot.description === 'string' && slot.description.trim().length > 0
			? slot.description
			: 'Declared credential slot.'
	const declared: PackageCredentialSlot = { kind: slot.kind, description }
	if (typeof slot.provider === 'string' && slot.provider.trim().length > 0) {
		declared.provider = slot.provider
	}
	if (typeof slot.multiple === 'boolean') declared.multiple = slot.multiple
	return declared
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
