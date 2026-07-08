import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveLocalBinary } from '../node-runtime.ts'

type WranglerEnvName = 'preview' | 'production'

type WranglerMigration = {
	tag: string
	deleted_classes?: Array<string>
	new_sqlite_classes?: Array<string>
	renamed_classes?: Array<{
		from: string
		to: string
	}>
}

type D1DatabaseListEntry = {
	uuid: string
	name: string
}

type KvNamespaceListEntry = {
	id: string
	title: string
}

export function fail(message: string): never {
	console.error(message)
	process.exit(1)
}

function renderArg(value: string) {
	if (!value) return '""'
	if (/^[a-zA-Z0-9_./:-]+$/.test(value)) return value
	return JSON.stringify(value)
}

export function runWrangler(
	args: Array<string>,
	options?: { input?: string; quiet?: boolean },
) {
	const wranglerBin = resolveLocalBinary('wrangler')
	const result = spawnSync(wranglerBin, args, {
		encoding: 'utf8',
		stdio: 'pipe',
		input: options?.input,
		env: process.env,
	})

	const status = result.status ?? 1
	const stdout = result.stdout ?? ''
	const stderr = result.stderr ?? ''

	if (!options?.quiet) {
		const rendered = args.map(renderArg).join(' ')
		console.error(`wrangler: ${wranglerBin} ${rendered}`)
	}

	if (status !== 0) {
		if (options?.quiet) {
			const rendered = args.map(renderArg).join(' ')
			console.error(`wrangler (failed): ${wranglerBin} ${rendered}`)
		}
		const output = `${stdout}${stderr}`.trim()
		if (output) {
			console.error(output)
		}
	}

	return { status, stdout, stderr }
}

export function truncateWithSuffix(
	base: string,
	suffix: string,
	maxLen: number,
) {
	if (base.length + suffix.length <= maxLen) {
		return `${base}${suffix}`
	}
	const cut = Math.max(1, maxLen - suffix.length)
	const trimmed = base.slice(0, cut).replace(/-+$/g, '')
	return `${trimmed}${suffix}`
}

export function listD1Databases(): Array<D1DatabaseListEntry> {
	const result = runWrangler(['d1', 'list', '--json'], { quiet: true })
	if (result.status !== 0) {
		fail('Failed to list D1 databases (wrangler d1 list --json).')
	}
	try {
		return JSON.parse(result.stdout) as Array<D1DatabaseListEntry>
	} catch {
		fail('Could not parse JSON output from wrangler d1 list --json.')
	}
}

export function listKvNamespaces(): Array<KvNamespaceListEntry> {
	const result = runWrangler(['kv', 'namespace', 'list'], { quiet: true })
	if (result.status !== 0) {
		fail('Failed to list KV namespaces (wrangler kv namespace list).')
	}
	try {
		return JSON.parse(result.stdout) as Array<KvNamespaceListEntry>
	} catch {
		fail('Could not parse JSON output from wrangler kv namespace list.')
	}
}

const ansiEscape = String.fromCharCode(27)

/**
 * `wrangler r2 bucket list` has no JSON output; it prints labelled-value
 * blocks (`name: <bucket>` / `creation_date: ...`). Parse the bucket
 * names out of that listing. Piped wrangler output is normally
 * color-free, but ANSI sequences are stripped defensively.
 */
export function parseR2BucketListOutput(output: string): Array<string> {
	const names: Array<string> = []
	for (const line of output.split('\n')) {
		const plain = line
			.split(ansiEscape)
			.map((part, index) =>
				index === 0 ? part : part.replace(/^\[[0-9;]*m/, ''),
			)
			.join('')
		const match = /^name:\s*(\S+)\s*$/.exec(plain.trim())
		if (match?.[1]) names.push(match[1])
	}
	return names
}

export function listR2BucketNames(): Array<string> {
	const result = runWrangler(['r2', 'bucket', 'list'], { quiet: true })
	if (result.status !== 0) {
		fail('Failed to list R2 buckets (wrangler r2 bucket list).')
	}
	return parseR2BucketListOutput(result.stdout)
}

export function ensureR2Bucket({
	name,
	dryRun,
}: {
	name: string
	dryRun: boolean
}): { name: string } {
	if (dryRun) {
		console.error(`[dry-run] ensure R2 bucket: ${name}`)
		return { name }
	}

	if (listR2BucketNames().includes(name)) {
		console.error(`R2 bucket exists: ${name}`)
		return { name }
	}

	const createResult = runWrangler(['r2', 'bucket', 'create', name], {
		quiet: true,
	})
	if (createResult.status !== 0) {
		fail(`Failed to create R2 bucket: ${name}`)
	}

	if (!listR2BucketNames().includes(name)) {
		fail(`Created R2 bucket "${name}" but could not find it via list.`)
	}
	console.error(`Created R2 bucket: ${name}`)
	return { name }
}

export function deleteR2Bucket({
	name,
	dryRun,
}: {
	name: string
	dryRun: boolean
}) {
	if (dryRun) {
		console.error(`[dry-run] delete R2 bucket: ${name}`)
		return
	}

	if (!listR2BucketNames().includes(name)) {
		console.error(`R2 bucket already deleted: ${name}`)
		return
	}

	const result = runWrangler(['r2', 'bucket', 'delete', name], { quiet: true })
	if (result.status !== 0) {
		// R2 refuses to delete non-empty buckets and wrangler has no purge
		// command; a leftover preview bucket is preferable to a failed
		// cleanup run, so warn instead of failing the workflow.
		console.error(
			`Warning: failed to delete R2 bucket ${name} (it may not be empty); it must be cleaned up manually.`,
		)
		return
	}
	console.error(`Deleted R2 bucket: ${name}`)
}

function stripJsonc(source: string) {
	let output = ''
	let inString = false
	let stringQuote = ''
	let isEscaped = false
	let inLineComment = false
	let inBlockComment = false

	for (let index = 0; index < source.length; index += 1) {
		const char = source[index] ?? ''
		const next = source[index + 1] ?? ''

		if (inLineComment) {
			if (char === '\n') {
				inLineComment = false
				output += char
			}
			continue
		}

		if (inBlockComment) {
			if (char === '*' && next === '/') {
				inBlockComment = false
				index += 1
			}
			continue
		}

		if (inString) {
			output += char
			if (isEscaped) {
				isEscaped = false
				continue
			}
			if (char === '\\') {
				isEscaped = true
				continue
			}
			if (char === stringQuote) {
				inString = false
				stringQuote = ''
			}
			continue
		}

		if (char === '"' || char === "'") {
			inString = true
			stringQuote = char
			output += char
			continue
		}

		if (char === '/' && next === '/') {
			inLineComment = true
			index += 1
			continue
		}

		if (char === '/' && next === '*') {
			inBlockComment = true
			index += 1
			continue
		}

		output += char
	}

	return output
}

function stripTrailingCommas(source: string) {
	let output = ''
	let inString = false
	let stringQuote = ''
	let isEscaped = false

	for (let index = 0; index < source.length; index += 1) {
		const char = source[index] ?? ''

		if (inString) {
			output += char
			if (isEscaped) {
				isEscaped = false
				continue
			}
			if (char === '\\') {
				isEscaped = true
				continue
			}
			if (char === stringQuote) {
				inString = false
				stringQuote = ''
			}
			continue
		}

		if (char === '"' || char === "'") {
			inString = true
			stringQuote = char
			output += char
			continue
		}

		if (char === ',') {
			let lookahead = index + 1
			while (lookahead < source.length) {
				const next = source[lookahead] ?? ''
				if (next === ' ' || next === '\t' || next === '\n' || next === '\r') {
					lookahead += 1
					continue
				}
				if (next === '}' || next === ']') {
					// Skip comma before a closing token, preserve whitespace.
					break
				}
				break
			}
			const nextNonWhitespace = source[lookahead] ?? ''
			if (nextNonWhitespace === '}' || nextNonWhitespace === ']') {
				continue
			}
		}

		output += char
	}

	return output
}

export function parseJsonc<T>(source: string): T {
	const withoutBom = source.replace(/^\uFEFF/, '')
	const noComments = stripJsonc(withoutBom)
	const json = stripTrailingCommas(noComments)
	return JSON.parse(json) as T
}

function getMigrationTagVersion(tag: unknown) {
	if (typeof tag !== 'string') return undefined
	const match = /^v(\d+)$/.exec(tag)
	if (!match) return undefined
	return Number(match[1])
}

function sortWranglerMigrations(migrations: Array<Record<string, unknown>>) {
	const orderedMigrations = migrations
		.map((migration, index) => ({
			index,
			migration,
			version: getMigrationTagVersion(migration.tag),
		}))
		.sort((left, right) => {
			if (
				left.version === undefined ||
				right.version === undefined ||
				left.version === right.version
			) {
				return left.index - right.index
			}

			return left.version - right.version
		})
		.map(({ migration }) => migration)

	migrations.splice(0, migrations.length, ...orderedMigrations)
}

export async function writeGeneratedWranglerConfig({
	baseConfigPath,
	outConfigPath,
	envName,
	workerName,
	d1DatabaseName,
	d1DatabaseId,
	oauthKvId,
	bundleArtifactsKvId,
	emailBlobsBucketName,
	workerVars,
	extraMigrations,
}: {
	baseConfigPath: string
	outConfigPath: string
	envName: WranglerEnvName
	workerName?: string
	d1DatabaseName: string
	d1DatabaseId: string
	oauthKvId: string
	bundleArtifactsKvId: string
	emailBlobsBucketName: string
	workerVars?: Record<string, string | undefined>
	extraMigrations?: Array<WranglerMigration>
}) {
	const baseText = await readFile(baseConfigPath, 'utf8')
	const config = parseJsonc<Record<string, unknown>>(baseText)

	const env = config.env
	if (!env || typeof env !== 'object') {
		fail(`wrangler config "${baseConfigPath}" is missing "env".`)
	}

	const targetEnv = (env as Record<string, unknown>)[envName]
	if (!targetEnv || typeof targetEnv !== 'object') {
		fail(`wrangler config "${baseConfigPath}" is missing "env.${envName}".`)
	}

	if (workerName) {
		config.name = workerName
	}

	const targetAssets = (targetEnv as Record<string, unknown>).assets
	if (
		!targetAssets ||
		typeof targetAssets !== 'object' ||
		Array.isArray(targetAssets)
	) {
		fail(
			`wrangler config "${baseConfigPath}" is missing "env.${envName}.assets".`,
		)
	}
	config.assets = { ...(targetAssets as Record<string, unknown>) }

	const d1Databases = (targetEnv as Record<string, unknown>).d1_databases
	if (!Array.isArray(d1Databases)) {
		fail(
			`wrangler config "${baseConfigPath}" is missing "env.${envName}.d1_databases".`,
		)
	}

	const d1EntryIndex = d1Databases.findIndex((entry) => {
		if (!entry || typeof entry !== 'object') return false
		return (entry as Record<string, unknown>).binding === 'APP_DB'
	})
	if (d1EntryIndex < 0) {
		fail(
			`wrangler config "${baseConfigPath}" has no ${envName} D1 binding for "APP_DB".`,
		)
	}

	const d1Entry = d1Databases[d1EntryIndex] as Record<string, unknown>
	d1Databases[d1EntryIndex] = {
		...d1Entry,
		database_name: d1DatabaseName,
		database_id: d1DatabaseId,
	}

	const kvNamespaces = (targetEnv as Record<string, unknown>).kv_namespaces
	if (!Array.isArray(kvNamespaces)) {
		fail(
			`wrangler config "${baseConfigPath}" is missing "env.${envName}.kv_namespaces".`,
		)
	}

	const oauthKvEntryIndex = kvNamespaces.findIndex((entry) => {
		if (!entry || typeof entry !== 'object') return false
		return (entry as Record<string, unknown>).binding === 'OAUTH_KV'
	})
	if (oauthKvEntryIndex < 0) {
		fail(
			`wrangler config "${baseConfigPath}" has no ${envName} KV binding for "OAUTH_KV".`,
		)
	}

	const oauthKvEntry = kvNamespaces[oauthKvEntryIndex] as Record<
		string,
		unknown
	>
	kvNamespaces[oauthKvEntryIndex] = {
		...oauthKvEntry,
		id: oauthKvId,
		preview_id: oauthKvId,
	}

	const bundleArtifactsKvEntryIndex = kvNamespaces.findIndex((entry) => {
		if (!entry || typeof entry !== 'object') return false
		return (entry as Record<string, unknown>).binding === 'BUNDLE_ARTIFACTS_KV'
	})
	if (bundleArtifactsKvEntryIndex < 0) {
		fail(
			`wrangler config "${baseConfigPath}" has no ${envName} KV binding for "BUNDLE_ARTIFACTS_KV".`,
		)
	}

	const bundleArtifactsKvEntry = kvNamespaces[
		bundleArtifactsKvEntryIndex
	] as Record<string, unknown>
	kvNamespaces[bundleArtifactsKvEntryIndex] = {
		...bundleArtifactsKvEntry,
		id: bundleArtifactsKvId,
		preview_id: bundleArtifactsKvId,
	}

	const r2Buckets = (targetEnv as Record<string, unknown>).r2_buckets
	if (!Array.isArray(r2Buckets)) {
		fail(
			`wrangler config "${baseConfigPath}" is missing "env.${envName}.r2_buckets".`,
		)
	}

	const emailBlobsEntryIndex = r2Buckets.findIndex((entry) => {
		if (!entry || typeof entry !== 'object') return false
		return (entry as Record<string, unknown>).binding === 'EMAIL_BLOBS'
	})
	if (emailBlobsEntryIndex < 0) {
		fail(
			`wrangler config "${baseConfigPath}" has no ${envName} R2 binding for "EMAIL_BLOBS".`,
		)
	}

	const emailBlobsEntry = r2Buckets[emailBlobsEntryIndex] as Record<
		string,
		unknown
	>
	r2Buckets[emailBlobsEntryIndex] = {
		...emailBlobsEntry,
		bucket_name: emailBlobsBucketName,
	}

	const existingVars = (targetEnv as Record<string, unknown>).vars
	if (
		existingVars !== undefined &&
		(existingVars === null ||
			typeof existingVars !== 'object' ||
			Array.isArray(existingVars))
	) {
		fail(
			`wrangler config "${baseConfigPath}" has invalid "env.${envName}.vars".`,
		)
	}

	const resolvedVars = {
		...((existingVars as Record<string, unknown> | undefined) ?? {}),
	}
	for (const [key, value] of Object.entries(workerVars ?? {})) {
		if (typeof value === 'string' && value.length > 0) {
			resolvedVars[key] = value
		}
	}
	;(targetEnv as Record<string, unknown>).vars = resolvedVars

	const migrations = config.migrations
	if (extraMigrations && extraMigrations.length > 0) {
		if (!Array.isArray(migrations)) {
			fail(
				`wrangler config "${baseConfigPath}" is missing top-level "migrations".`,
			)
		}

		const migrationList = migrations as Array<Record<string, unknown>>
		for (const extraMigration of extraMigrations) {
			const alreadyExists = migrationList.some((migration) => {
				return migration.tag === extraMigration.tag
			})
			if (!alreadyExists) {
				migrationList.push(extraMigration)
			}
		}
		sortWranglerMigrations(migrationList)
	}

	const resolvedOut = path.resolve(outConfigPath)
	await writeFile(
		resolvedOut,
		`${JSON.stringify(config, null, '\t')}\n`,
		'utf8',
	)
	console.error(`Wrote generated Wrangler config: ${resolvedOut}`)
	return resolvedOut
}
