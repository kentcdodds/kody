import {
	fail,
	listD1Databases,
	listKvNamespaces,
	runWrangler,
	truncateWithSuffix,
	writeGeneratedWranglerConfig,
} from './resource-utils'

type Command = 'ensure' | 'cleanup'

type CliOptions = {
	workerName: string
	wranglerConfigPath: string
	outConfigPath: string
	dryRun: boolean
	d1Location?: string
}

function parseArgs(argv: Array<string>): {
	command: Command
	options: CliOptions
} {
	const command = argv[0]
	if (command !== 'ensure' && command !== 'cleanup') {
		fail(
			`Missing or invalid command. Usage: bun tools/ci/preview-resources.ts <ensure|cleanup> --worker-name <name>`,
		)
	}

	const options: CliOptions = {
		workerName: '',
		wranglerConfigPath: 'wrangler.jsonc',
		outConfigPath: 'wrangler-preview.generated.json',
		dryRun: false,
		d1Location: undefined,
	}

	for (let index = 1; index < argv.length; index += 1) {
		const arg = argv[index]
		if (!arg) continue
		switch (arg) {
			case '--worker-name': {
				options.workerName = argv[index + 1] ?? ''
				index += 1
				break
			}
			case '--wrangler-config': {
				options.wranglerConfigPath = argv[index + 1] ?? ''
				index += 1
				break
			}
			case '--out-config': {
				options.outConfigPath = argv[index + 1] ?? ''
				index += 1
				break
			}
			case '--d1-location': {
				options.d1Location = argv[index + 1] ?? ''
				index += 1
				break
			}
			case '--dry-run': {
				options.dryRun = true
				break
			}
			default: {
				if (arg.startsWith('-')) {
					fail(`Unknown flag: ${arg}`)
				}
			}
		}
	}

	if (!options.workerName) {
		fail('Missing required flag: --worker-name <name>')
	}

	if (command === 'ensure' && !options.outConfigPath) {
		fail('Missing required flag: --out-config <path>')
	}

	return { command, options }
}

function buildPreviewResourceNames(workerName: string) {
	const maxLen = 63
	const d1Suffix = '-db'
	const kvSuffix = '-oauth-kv'

	const d1DatabaseName = truncateWithSuffix(workerName, d1Suffix, maxLen)
	const oauthKvTitle = truncateWithSuffix(workerName, kvSuffix, maxLen)

	return { d1DatabaseName, oauthKvTitle }
}

function ensureD1Database({
	name,
	location,
	dryRun,
}: {
	name: string
	location?: string
	dryRun: boolean
}) {
	if (dryRun) {
		console.error(`[dry-run] ensure D1 database: ${name}`)
		return { name, id: `dry-run-${name}` }
	}

	const existing = listD1Databases().find((db) => db.name === name)
	if (existing) {
		console.error(`D1 database exists: ${name} (${existing.uuid})`)
		return { name, id: existing.uuid }
	}

	const args = ['d1', 'create', name]
	if (location && location.length > 0) {
		args.push('--location', location)
	}
	// If Wrangler prompts to update config, always answer "no".
	const createResult = runWrangler(args, { input: 'n\n', quiet: true })
	if (createResult.status !== 0) {
		fail(`Failed to create D1 database: ${name}`)
	}

	const created = listD1Databases().find((db) => db.name === name)
	if (!created) {
		fail(`Created D1 database "${name}" but could not find it via list.`)
	}
	console.error(`Created D1 database: ${name} (${created.uuid})`)
	return { name, id: created.uuid }
}

function deleteD1Database({ name, dryRun }: { name: string; dryRun: boolean }) {
	if (dryRun) {
		console.error(`[dry-run] delete D1 database: ${name}`)
		return
	}

	const existing = listD1Databases().some((db) => db.name === name)
	if (!existing) {
		console.error(`D1 database already deleted: ${name}`)
		return
	}

	const result = runWrangler(['d1', 'delete', name, '--skip-confirmation'], {
		quiet: true,
	})
	if (result.status !== 0) {
		fail(`Failed to delete D1 database: ${name}`)
	}
	console.error(`Deleted D1 database: ${name}`)
}

function ensureKvNamespace({
	title,
	dryRun,
}: {
	title: string
	dryRun: boolean
}) {
	if (dryRun) {
		console.error(`[dry-run] ensure KV namespace: ${title}`)
		return { title, id: `dry-run-${title}` }
	}

	const existing = listKvNamespaces().find((ns) => ns.title === title)
	if (existing) {
		console.error(`KV namespace exists: ${title} (${existing.id})`)
		return { title, id: existing.id }
	}

	// If Wrangler prompts to update config, always answer "no".
	const createResult = runWrangler(['kv', 'namespace', 'create', title], {
		input: 'n\n',
		quiet: true,
	})
	if (createResult.status !== 0) {
		fail(`Failed to create KV namespace: ${title}`)
	}

	const created = listKvNamespaces().find((ns) => ns.title === title)
	if (!created) {
		fail(`Created KV namespace "${title}" but could not find it via list.`)
	}
	console.error(`Created KV namespace: ${title} (${created.id})`)
	return { title, id: created.id }
}

function deleteKvNamespace({
	title,
	dryRun,
}: {
	title: string
	dryRun: boolean
}) {
	if (dryRun) {
		console.error(`[dry-run] delete KV namespace: ${title}`)
		return
	}

	const existing = listKvNamespaces().find((ns) => ns.title === title)
	if (!existing) {
		console.error(`KV namespace already deleted: ${title}`)
		return
	}

	const result = runWrangler(
		[
			'kv',
			'namespace',
			'delete',
			'--namespace-id',
			existing.id,
			'--skip-confirmation',
		],
		{ quiet: true },
	)
	if (result.status !== 0) {
		fail(`Failed to delete KV namespace: ${title}`)
	}
	console.error(`Deleted KV namespace: ${title} (${existing.id})`)
}

async function ensurePreviewResources(options: CliOptions) {
	const { d1DatabaseName, oauthKvTitle } = buildPreviewResourceNames(
		options.workerName,
	)
	const d1 = ensureD1Database({
		name: d1DatabaseName,
		location: options.d1Location,
		dryRun: options.dryRun,
	})
	const kv = ensureKvNamespace({ title: oauthKvTitle, dryRun: options.dryRun })

	const generatedConfigPath = await writeGeneratedWranglerConfig({
		baseConfigPath: options.wranglerConfigPath,
		outConfigPath: options.outConfigPath,
		envName: 'preview',
		d1DatabaseName: d1.name,
		d1DatabaseId: d1.id,
		oauthKvId: kv.id,
	})

	// Emit GitHub Actions-friendly outputs (stdout only).
	console.log(`wrangler_config=${generatedConfigPath}`)
	console.log(`d1_database_name=${d1.name}`)
	console.log(`d1_database_id=${d1.id}`)
	console.log(`oauth_kv_title=${kv.title}`)
	console.log(`oauth_kv_id=${kv.id}`)
}

async function cleanupPreviewResources(options: CliOptions) {
	const { d1DatabaseName, oauthKvTitle } = buildPreviewResourceNames(
		options.workerName,
	)
	deleteKvNamespace({ title: oauthKvTitle, dryRun: options.dryRun })
	deleteD1Database({ name: d1DatabaseName, dryRun: options.dryRun })
}

async function main() {
	const { command, options } = parseArgs(process.argv.slice(2))

	if (!process.env.CLOUDFLARE_API_TOKEN && !options.dryRun) {
		fail(
			'Missing CLOUDFLARE_API_TOKEN (required for Wrangler resource operations).',
		)
	}

	if (command === 'ensure') {
		await ensurePreviewResources(options)
		return
	}

	await cleanupPreviewResources(options)
}

await main()
