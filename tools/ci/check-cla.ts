import { readFile } from 'node:fs/promises'
import { isExecutedDirectly } from '../node-runtime.ts'

export type ClaIdentity = {
	githubLogin: string | null
	name: string | null
	email: string | null
}

export type ClaSigner = {
	github: string
	signedAt: string
	cla: 'individual' | 'entity'
}

export type ClaSignersFile = {
	version: 1
	document: string
	allowlist: {
		github: Array<string>
		email: Array<string>
	}
	signers: Array<ClaSigner>
}

export type ClaMissingIdentity = {
	identity: ClaIdentity
	reason: string
}

export type ClaCheckResult =
	| { ok: true }
	| { ok: false; missing: Array<ClaMissingIdentity> }

const githubBotLoginPattern = /\[bot\]$/i

function normalize(value: string) {
	return value.trim().toLowerCase()
}

function identityLabel(identity: ClaIdentity) {
	if (identity.githubLogin) {
		return `@${identity.githubLogin}`
	}
	if (identity.email) {
		return identity.email
	}
	if (identity.name) {
		return identity.name
	}
	return 'unknown identity'
}

export function parseClaSignersFile(raw: string): ClaSignersFile {
	const parsed: unknown = JSON.parse(raw)
	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		!('version' in parsed) ||
		parsed.version !== 1
	) {
		throw new Error('CLA signers file must be version 1 JSON')
	}

	const file = parsed as ClaSignersFile
	if (
		typeof file.document !== 'string' ||
		typeof file.allowlist !== 'object' ||
		file.allowlist === null ||
		!Array.isArray(file.allowlist.github) ||
		!Array.isArray(file.allowlist.email) ||
		!Array.isArray(file.signers)
	) {
		throw new Error('CLA signers file is missing allowlist or signers')
	}

	return file
}

export function isAllowlistedIdentity(
	identity: ClaIdentity,
	signersFile: ClaSignersFile,
) {
	const login = identity.githubLogin ? normalize(identity.githubLogin) : null
	if (
		login &&
		(githubBotLoginPattern.test(login) || login.startsWith('app/'))
	) {
		return true
	}
	if (
		login &&
		signersFile.allowlist.github.some((entry) => normalize(entry) === login)
	) {
		return true
	}

	const email = identity.email ? normalize(identity.email) : null
	return Boolean(
		email &&
		signersFile.allowlist.email.some((entry) => normalize(entry) === email),
	)
}

export function hasSignedCla(
	identity: ClaIdentity,
	signersFile: ClaSignersFile,
) {
	const login = identity.githubLogin ? normalize(identity.githubLogin) : null
	if (!login) {
		return false
	}

	return signersFile.signers.some(
		(signer) => normalize(signer.github) === login,
	)
}

export function checkClaIdentities(
	identities: ReadonlyArray<ClaIdentity>,
	signersFile: ClaSignersFile,
): ClaCheckResult {
	const missing: Array<ClaMissingIdentity> = []
	const seen = new Set<string>()

	for (const identity of identities) {
		const key = [identity.githubLogin, identity.email, identity.name]
			.map((part) => (part ? normalize(part) : ''))
			.join('|')
		if (seen.has(key)) {
			continue
		}
		seen.add(key)

		if (isAllowlistedIdentity(identity, signersFile)) {
			continue
		}
		if (hasSignedCla(identity, signersFile)) {
			continue
		}

		const reason = identity.githubLogin
			? `${identityLabel(identity)} has not signed the CLA`
			: `${identityLabel(identity)} has no GitHub login and is not a Licensor email`
		missing.push({ identity, reason })
	}

	return missing.length === 0 ? { ok: true } : { ok: false, missing }
}

export function formatClaFailure(
	result: Extract<ClaCheckResult, { ok: false }>,
) {
	const lines = [
		'Unsigned contributions cannot merge.',
		'Read docs/legal/individual-cla.md (or the Entity CLA if an organization owns the work).',
		'Comment on the pull request: I have read the CLA and I hereby sign the CLA',
		'A maintainer then records your GitHub username on main. See docs/contributing/inbound-contributions.md.',
		'',
		'Missing signatures:',
		...result.missing.map((entry) => `- ${entry.reason}`),
	]
	return lines.join('\n')
}

async function runCli(args: Array<string>) {
	const signersFlag = args.indexOf('--signers')
	const identitiesFlag = args.indexOf('--identities-json')
	const signersPath = signersFlag === -1 ? null : args[signersFlag + 1]
	const identitiesPath = identitiesFlag === -1 ? null : args[identitiesFlag + 1]

	if (!signersPath || !identitiesPath) {
		throw new Error(
			'Usage: node tools/ci/check-cla.ts --signers <file> --identities-json <file>',
		)
	}

	const signersFile = parseClaSignersFile(await readFile(signersPath, 'utf8'))
	const identitiesRaw: unknown = JSON.parse(
		await readFile(identitiesPath, 'utf8'),
	)
	if (!Array.isArray(identitiesRaw)) {
		throw new Error('Identities JSON must be an array')
	}

	const result = checkClaIdentities(
		identitiesRaw as Array<ClaIdentity>,
		signersFile,
	)
	if (!result.ok) {
		console.error(formatClaFailure(result))
		process.exitCode = 1
	}
}

if (isExecutedDirectly(import.meta.url)) {
	await runCli(process.argv.slice(2))
}
