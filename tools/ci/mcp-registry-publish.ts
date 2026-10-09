/**
 * MCP Registry publish decisions for `server.json`.
 *
 * The registry rejects a republish of an existing version (`cannot publish
 * duplicate version`). Metadata edits must bump `version` in the same change.
 * A matching already-published payload is a successful no-op.
 *
 * Usage:
 *   node tools/ci/mcp-registry-publish.ts decide
 *   node tools/ci/mcp-registry-publish.ts interpret-error --text "…"
 *   node tools/ci/mcp-registry-publish.ts check-version-bump
 */
import { execFile } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { isExecutedDirectly } from '../node-runtime.ts'

const execFileAsync = promisify(execFile)

export const defaultServerJsonPath = 'server.json'
export const mcpRegistryBaseUrl = 'https://registry.modelcontextprotocol.io'
export const duplicateVersionPublishErrorPattern =
	/cannot publish duplicate version/i

export type ServerJson = {
	name: string
	version: string
	[key: string]: unknown
}

export type PublishDecision =
	| { action: 'publish'; reason: string }
	| { action: 'skip'; reason: string }
	| { action: 'fail'; reason: string }

export type ServerJsonChange = 'unchanged' | 'ok' | 'needs-version-bump'

export type PublishedLookup =
	| { ok: true; server: ServerJson | null }
	| { ok: false; error: string }

export type VersionBumpCheckResult = {
	ok: boolean
	kind: 'ok' | 'unchanged' | 'needs-version-bump' | 'skipped'
	message: string
}

type CliCommand = 'decide' | 'interpret-error' | 'check-version-bump'

const usage = [
	'Usage:',
	'  node tools/ci/mcp-registry-publish.ts decide',
	'  node tools/ci/mcp-registry-publish.ts interpret-error --text "<publisher output>"',
	'  node tools/ci/mcp-registry-publish.ts check-version-bump',
].join('\n')

export function canonicalizeJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => canonicalizeJsonValue(entry))
	}
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>
		return Object.fromEntries(
			Object.keys(record)
				.sort()
				.map((key) => [key, canonicalizeJsonValue(record[key])]),
		)
	}
	return value
}

export function serverJsonEquals(left: ServerJson, right: ServerJson) {
	return (
		JSON.stringify(canonicalizeJsonValue(left)) ===
		JSON.stringify(canonicalizeJsonValue(right))
	)
}

export function parseServerJson(raw: string): ServerJson {
	const parsed: unknown = JSON.parse(raw)
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('server.json must be a JSON object.')
	}
	const record = parsed as Record<string, unknown>
	const name = record['name']
	const version = record['version']
	if (typeof name !== 'string' || name.trim() === '') {
		throw new Error('server.json is missing a non-empty "name".')
	}
	if (typeof version !== 'string' || version.trim() === '') {
		throw new Error('server.json is missing a non-empty "version".')
	}
	return record as ServerJson
}

export function registryServerVersionUrl(name: string, version: string) {
	return `${mcpRegistryBaseUrl}/v0.1/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`
}

export function parsePublishedServerResponse(payload: unknown): ServerJson {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		throw new Error('MCP registry version response must be a JSON object.')
	}
	const server = (payload as { server?: unknown }).server
	if (server === undefined) {
		return parseServerJson(JSON.stringify(payload))
	}
	return parseServerJson(JSON.stringify(server))
}

export function classifyPublishedVersion(input: {
	local: ServerJson
	published: ServerJson | null
	fetchFailed?: boolean
}): PublishDecision {
	if (input.fetchFailed) {
		return {
			action: 'publish',
			reason: `Could not look up ${input.local.name}@${input.local.version}; trying publish.`,
		}
	}
	if (!input.published) {
		return {
			action: 'publish',
			reason: `${input.local.name}@${input.local.version} is not in the registry.`,
		}
	}
	if (serverJsonEquals(input.local, input.published)) {
		return {
			action: 'skip',
			reason: `${input.local.name}@${input.local.version} is already published with this payload.`,
		}
	}
	return {
		action: 'fail',
		reason: `${input.local.name}@${input.local.version} is already published with different metadata. Bump server.json version in the same change.`,
	}
}

export function classifyServerJsonChange(input: {
	base: ServerJson | null
	head: ServerJson
}): ServerJsonChange {
	if (!input.base) return 'ok'
	if (serverJsonEquals(input.base, input.head)) return 'unchanged'
	if (input.base.version !== input.head.version) return 'ok'
	return 'needs-version-bump'
}

export function isDuplicateVersionPublishError(text: string) {
	return duplicateVersionPublishErrorPattern.test(text)
}

export async function lookupPublishedServer(input: {
	name: string
	version: string
	fetchImpl?: typeof fetch
}): Promise<PublishedLookup> {
	const fetchImpl = input.fetchImpl ?? fetch
	const url = registryServerVersionUrl(input.name, input.version)
	try {
		const response = await fetchImpl(url, {
			signal: AbortSignal.timeout(10_000),
		})
		if (response.status === 404) {
			return { ok: true, server: null }
		}
		if (!response.ok) {
			return {
				ok: false,
				error: `MCP registry lookup failed: HTTP ${String(response.status)}`,
			}
		}
		return {
			ok: true,
			server: parsePublishedServerResponse(await response.json()),
		}
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

export async function decidePublish(input: {
	local: ServerJson
	fetchImpl?: typeof fetch
}): Promise<PublishDecision> {
	const lookup = await lookupPublishedServer({
		name: input.local.name,
		version: input.local.version,
		fetchImpl: input.fetchImpl,
	})
	if (!lookup.ok) {
		return classifyPublishedVersion({
			local: input.local,
			published: null,
			fetchFailed: true,
		})
	}
	return classifyPublishedVersion({
		local: input.local,
		published: lookup.server,
	})
}

export async function interpretPublishError(input: {
	text: string
	local: ServerJson
	fetchImpl?: typeof fetch
}): Promise<PublishDecision> {
	if (!isDuplicateVersionPublishError(input.text)) {
		return {
			action: 'fail',
			reason: input.text || 'mcp-publisher publish failed.',
		}
	}
	const lookup = await lookupPublishedServer({
		name: input.local.name,
		version: input.local.version,
		fetchImpl: input.fetchImpl,
	})
	if (!lookup.ok) {
		return {
			action: 'fail',
			reason: `Publish reported a duplicate version, but registry lookup failed (${lookup.error}). Cannot confirm the published payload matches.`,
		}
	}
	if (!lookup.server) {
		return {
			action: 'fail',
			reason: `Publish reported a duplicate version, but ${input.local.name}@${input.local.version} was not visible on lookup. Cannot confirm the published payload matches.`,
		}
	}
	return classifyPublishedVersion({
		local: input.local,
		published: lookup.server,
	})
}

async function gitOutput(
	args: ReadonlyArray<string>,
	cwd: string,
): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync('git', [...args], {
			cwd,
			encoding: 'utf8',
		})
		return stdout
	} catch {
		return null
	}
}

export async function resolveServerJsonValidationBase(
	input: {
		cwd?: string
		env?: NodeJS.ProcessEnv
		git?: (args: ReadonlyArray<string>, cwd: string) => Promise<string | null>
	} = {},
): Promise<string | null> {
	const cwd = input.cwd ?? process.cwd()
	const env = input.env ?? process.env
	const git = input.git ?? gitOutput
	const head = (await git(['rev-parse', 'HEAD^{commit}'], cwd))?.trim()
	if (!head) return null

	const explicitCandidates = [
		env.MCP_REGISTRY_VALIDATION_BASE,
		env.MIGRATION_VALIDATION_BASE,
		env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : undefined,
	].filter((candidate): candidate is string => Boolean(candidate))
	for (const candidate of explicitCandidates) {
		if (/^0+$/.test(candidate)) continue
		const commit = (
			await git(['rev-parse', `${candidate}^{commit}`], cwd)
		)?.trim()
		if (commit && commit !== head) return commit
	}

	for (const candidate of ['origin/main', 'main']) {
		const mergeBase = (
			await git(['merge-base', 'HEAD', candidate], cwd)
		)?.trim()
		if (mergeBase && mergeBase !== head) return mergeBase
	}

	const firstParent = (await git(['rev-parse', 'HEAD^1'], cwd))?.trim()
	return firstParent && firstParent !== head ? firstParent : null
}

export async function readBaseServerJson(input: {
	ref: string
	cwd?: string
	path?: string
	git?: (args: ReadonlyArray<string>, cwd: string) => Promise<string | null>
}): Promise<ServerJson | null> {
	const cwd = input.cwd ?? process.cwd()
	const filePath = input.path ?? defaultServerJsonPath
	const git = input.git ?? gitOutput
	const raw = await git(['show', `${input.ref}:${filePath}`], cwd)
	if (raw === null) return null
	return parseServerJson(raw)
}

export async function checkServerJsonVersionBump(
	input: {
		cwd?: string
		head?: ServerJson
		env?: NodeJS.ProcessEnv
		git?: (args: ReadonlyArray<string>, cwd: string) => Promise<string | null>
	} = {},
): Promise<VersionBumpCheckResult> {
	const cwd = input.cwd ?? process.cwd()
	const head =
		input.head ??
		parseServerJson(readFileSync(path.join(cwd, defaultServerJsonPath), 'utf8'))
	const baseRef = await resolveServerJsonValidationBase({
		cwd,
		env: input.env,
		git: input.git,
	})
	if (!baseRef) {
		return {
			ok: true,
			kind: 'skipped',
			message:
				'No comparable Git base for server.json; skipped MCP registry version-bump check.',
		}
	}
	const base = await readBaseServerJson({
		ref: baseRef,
		cwd,
		git: input.git,
	})
	const kind = classifyServerJsonChange({ base, head })
	switch (kind) {
		case 'unchanged':
			return {
				ok: true,
				kind,
				message: `server.json matches ${baseRef}; MCP registry version is unchanged.`,
			}
		case 'ok':
			return {
				ok: true,
				kind,
				message: `server.json changed and version is ${head.version}.`,
			}
		case 'needs-version-bump':
			return {
				ok: false,
				kind,
				message: `server.json metadata changed without bumping version (${head.version}). The MCP registry cannot republish a version; bump version in the same change.`,
			}
		default: {
			const _exhaustive: never = kind
			return _exhaustive
		}
	}
}

function writeGithubOutput(name: string, value: string) {
	const outputPath = process.env.GITHUB_OUTPUT
	if (!outputPath) return
	appendFileSync(outputPath, `${name}=${value}\n`)
}

function parseCliCommand(value: string | undefined): CliCommand {
	switch (value) {
		case 'decide':
		case 'interpret-error':
		case 'check-version-bump':
			return value
		default:
			throw new Error(usage)
	}
}

function readFlag(args: ReadonlyArray<string>, name: string) {
	const index = args.indexOf(name)
	if (index === -1) return undefined
	return args[index + 1]
}

export async function main(args = process.argv.slice(2)) {
	let command: CliCommand
	try {
		command = parseCliCommand(args[0])
	} catch (error) {
		console.error(error instanceof Error ? error.message : usage)
		process.exitCode = 1
		return
	}

	switch (command) {
		case 'decide': {
			const local = parseServerJson(readFileSync(defaultServerJsonPath, 'utf8'))
			const decision = await decidePublish({ local })
			switch (decision.action) {
				case 'skip':
					writeGithubOutput('action', 'skip')
					console.log(`::notice::${decision.reason}`)
					return
				case 'publish':
					writeGithubOutput('action', 'publish')
					console.log(decision.reason)
					return
				case 'fail':
					writeGithubOutput('action', 'fail')
					console.error(`::error::${decision.reason}`)
					process.exitCode = 1
					return
				default: {
					const _exhaustive: never = decision
					return _exhaustive
				}
			}
		}
		case 'interpret-error': {
			const local = parseServerJson(readFileSync(defaultServerJsonPath, 'utf8'))
			const decision = await interpretPublishError({
				text: readFlag(args, '--text') ?? '',
				local,
			})
			switch (decision.action) {
				case 'skip':
					console.log(`::notice::${decision.reason}`)
					return
				case 'fail':
					console.error(`::error::${decision.reason}`)
					process.exitCode = 1
					return
				case 'publish':
					console.error(
						`::error::${decision.reason} Duplicate publish cannot retry from interpret-error.`,
					)
					process.exitCode = 1
					return
				default: {
					const _exhaustive: never = decision
					return _exhaustive
				}
			}
		}
		case 'check-version-bump': {
			const result = await checkServerJsonVersionBump()
			if (result.ok) {
				console.log(result.message)
				return
			}
			console.error(result.message)
			process.exitCode = 1
			return
		}
		default: {
			const _exhaustive: never = command
			return _exhaustive
		}
	}
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
