import { isExecutedDirectly } from '../node-runtime.ts'
import {
	createCloudflareBackupApi,
	ensureBackupResources,
	generateBackupDesiredState,
	normalizeCloudflareAccountId,
	renderBackupOutput,
	type SourceD1Database,
} from './backup-resources.ts'

type BackupCliMode = 'plan' | 'apply'

type BackupCliOptions = {
	mode: BackupCliMode
	sourceAccountId: string
	destinationAccountId: string
	apiToken: string
	bucketName: string
	workerName: string
	sourceD1Databases: Array<SourceD1Database>
	productionResourceDenylist: Array<string>
}

function readFlagValue(
	argv: ReadonlyArray<string>,
	index: number,
	flag: string,
) {
	const value = argv[index + 1]
	if (!value || value.startsWith('--')) {
		throw new Error(`Missing value for ${flag}.`)
	}
	return value
}

function parseSourceD1(value: string): SourceD1Database {
	const separatorIndex = value.indexOf(':')
	if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
		throw new Error('--source-d1 must use <uuid>:<lower-kebab-name>.')
	}
	return {
		uuid: value.slice(0, separatorIndex),
		name: value.slice(separatorIndex + 1),
	}
}

function parseSourceD1Environment(value: string | undefined) {
	if (!value) return []
	let parsed: unknown
	try {
		parsed = JSON.parse(value)
	} catch {
		throw new Error(
			'BACKUP_SOURCE_D1_ALLOWLIST must be a JSON array of UUID/name objects.',
		)
	}
	if (!Array.isArray(parsed)) {
		throw new Error('BACKUP_SOURCE_D1_ALLOWLIST must be a JSON array.')
	}
	return parsed.map((entry) => {
		if (
			!entry ||
			typeof entry !== 'object' ||
			Array.isArray(entry) ||
			typeof (entry as Record<string, unknown>).uuid !== 'string' ||
			typeof (entry as Record<string, unknown>).name !== 'string'
		) {
			throw new Error(
				'BACKUP_SOURCE_D1_ALLOWLIST entries require string UUID and name.',
			)
		}
		return {
			uuid: (entry as Record<string, string>).uuid,
			name: (entry as Record<string, string>).name,
		}
	})
}

export function parseBackupCliArgs(
	argv: ReadonlyArray<string>,
	env: Readonly<Record<string, string | undefined>>,
): BackupCliOptions {
	let mode: BackupCliMode = 'plan'
	let index = 0
	if (argv[0] === 'plan' || argv[0] === 'apply') {
		mode = argv[0]
		index = 1
	} else if (argv[0] && !argv[0].startsWith('--')) {
		throw new Error(`Unknown backup command: ${argv[0]}.`)
	}

	let sourceAccountId = env.BACKUP_SOURCE_ACCOUNT_ID?.trim() ?? ''
	let destinationAccountId =
		env.BACKUP_DESTINATION_ACCOUNT_ID?.trim() ??
		env.CLOUDFLARE_ACCOUNT_ID?.trim() ??
		''
	let apiToken = env.CLOUDFLARE_API_TOKEN?.trim() ?? ''
	const serviceName = env.BACKUP_SERVICE_NAME?.trim() || 'kody'
	let bucketName =
		env.BACKUP_R2_BUCKET_NAME?.trim() || `${serviceName}-d1-backup-archive`
	let workerName =
		env.BACKUP_WORKER_NAME?.trim() || `${serviceName}-d1-backup-writer`
	const sourceD1Databases = parseSourceD1Environment(
		env.BACKUP_SOURCE_D1_ALLOWLIST,
	)
	const productionResourceDenylist = (env.PRODUCTION_RESOURCE_DENYLIST ?? '')
		.split(',')
		.map((value) => value.trim())
		.filter(Boolean)

	for (; index < argv.length; index += 1) {
		const flag = argv[index]
		switch (flag) {
			case '--source-account-id': {
				sourceAccountId = readFlagValue(argv, index, flag)
				index += 1
				break
			}
			case '--destination-account-id': {
				destinationAccountId = readFlagValue(argv, index, flag)
				index += 1
				break
			}
			case '--provisioner-token-env': {
				const variableName = readFlagValue(argv, index, flag)
				apiToken = env[variableName]?.trim() ?? ''
				index += 1
				break
			}
			case '--bucket-name': {
				bucketName = readFlagValue(argv, index, flag)
				index += 1
				break
			}
			case '--worker-name': {
				workerName = readFlagValue(argv, index, flag)
				index += 1
				break
			}
			case '--source-d1': {
				sourceD1Databases.push(parseSourceD1(readFlagValue(argv, index, flag)))
				index += 1
				break
			}
			case '--deny-production-resource': {
				productionResourceDenylist.push(readFlagValue(argv, index, flag))
				index += 1
				break
			}
			default: {
				throw new Error(`Unknown backup flag: ${flag ?? ''}.`)
			}
		}
	}

	if (!sourceAccountId) {
		throw new Error(
			'Source Cloudflare account ID is required via BACKUP_SOURCE_ACCOUNT_ID or --source-account-id.',
		)
	}
	if (!destinationAccountId) {
		throw new Error(
			'Destination Cloudflare account ID is required via BACKUP_DESTINATION_ACCOUNT_ID, CLOUDFLARE_ACCOUNT_ID, or --destination-account-id.',
		)
	}
	sourceAccountId = normalizeCloudflareAccountId(
		sourceAccountId,
		'Source Cloudflare account ID',
	)
	destinationAccountId = normalizeCloudflareAccountId(
		destinationAccountId,
		'Destination Cloudflare account ID',
	)
	if (sourceAccountId === destinationAccountId) {
		throw new Error(
			'Source and destination Cloudflare account IDs must be distinct.',
		)
	}
	if (!apiToken) {
		throw new Error(
			'Provisioner token is required via CLOUDFLARE_API_TOKEN or --provisioner-token-env.',
		)
	}
	return {
		mode,
		sourceAccountId,
		destinationAccountId,
		apiToken,
		bucketName,
		workerName,
		sourceD1Databases,
		productionResourceDenylist,
	}
}

export async function runBackupResourcesCli(input: {
	argv: ReadonlyArray<string>
	env: Readonly<Record<string, string | undefined>>
	fetcher?: typeof fetch
	log?: (output: string) => void
}) {
	const options = parseBackupCliArgs(input.argv, input.env)
	const desired = generateBackupDesiredState({
		sourceAccountId: options.sourceAccountId,
		destinationAccountId: options.destinationAccountId,
		bucketName: options.bucketName,
		workerName: options.workerName,
		sourceD1Databases: options.sourceD1Databases,
		productionResourceDenylist: options.productionResourceDenylist,
	})
	const api = createCloudflareBackupApi({
		destinationAccountId: options.destinationAccountId,
		apiToken: options.apiToken,
		fetcher: input.fetcher,
	})
	const result = await ensureBackupResources({
		api,
		desired,
		dryRun: options.mode === 'plan',
	})
	;(input.log ?? console.log)(renderBackupOutput(result))
	return result
}

async function main() {
	try {
		await runBackupResourcesCli({
			argv: process.argv.slice(2),
			env: process.env,
		})
	} catch (error) {
		const message =
			error instanceof Error ? error.message : 'Backup CLI failed.'
		console.error(message)
		process.exitCode = 1
	}
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
