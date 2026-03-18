import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

type WranglerEnvName = 'preview' | 'production'

export type D1DatabaseListEntry = {
	uuid: string
	name: string
}

export type KvNamespaceListEntry = {
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
	const bunBin = process.execPath
	const result = spawnSync(bunBin, ['x', 'wrangler', ...args], {
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
		console.error(`wrangler: bun x wrangler ${rendered}`)
	}

	if (status !== 0) {
		if (options?.quiet) {
			const rendered = args.map(renderArg).join(' ')
			console.error(`wrangler (failed): bun x wrangler ${rendered}`)
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

export async function writeGeneratedWranglerConfig({
	baseConfigPath,
	outConfigPath,
	envName,
	d1DatabaseName,
	d1DatabaseId,
	oauthKvId,
}: {
	baseConfigPath: string
	outConfigPath: string
	envName: WranglerEnvName
	d1DatabaseName: string
	d1DatabaseId: string
	oauthKvId: string
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

	const kvEntryIndex = kvNamespaces.findIndex((entry) => {
		if (!entry || typeof entry !== 'object') return false
		return (entry as Record<string, unknown>).binding === 'OAUTH_KV'
	})
	if (kvEntryIndex < 0) {
		fail(
			`wrangler config "${baseConfigPath}" has no ${envName} KV binding for "OAUTH_KV".`,
		)
	}

	const kvEntry = kvNamespaces[kvEntryIndex] as Record<string, unknown>
	kvNamespaces[kvEntryIndex] = {
		...kvEntry,
		id: oauthKvId,
		preview_id: oauthKvId,
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
