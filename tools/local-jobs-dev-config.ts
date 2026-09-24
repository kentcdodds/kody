import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseJsonc } from './ci/resource-utils.ts'

type JsonRecord = Record<string, unknown>

/**
 * Builds a local-dev variant of the jobs worker config for Vite and
 * multi-config `wrangler dev`. Wrangler registers each secondary worker as
 * `<name>-<env>` unless that env sets `name`. Origin's production `JOBS`
 * binding is `kody-jobs`, so the unsuffixed committed config registers as
 * `kody-jobs-production` and `/account/usage` fails with Worker "kody-jobs"
 * not found. The generated file pins `env.<env>.name` to the service name
 * that env's origin `JOBS` binding uses, and points that env's `HOST`
 * binding at the name the origin worker registers under locally
 * (`<name>-<env>`, or `env.name` when that env pins one). Preview's
 * committed `HOST` is `kody` because deploy rewrites it per PR; local
 * preview registers the origin as `kody-preview`. The test env already
 * wants `kody-jobs-test`, which is the suffixed name, so that pin matches
 * it. Do not commit the pin: production deploys name the worker differently.
 */
export async function writeLocalJobsDevConfig({
	jobsConfigPath,
	originConfigPath,
	envName,
}: {
	jobsConfigPath: string
	originConfigPath: string
	envName: string
}) {
	const [jobsSource, originSource] = await Promise.all([
		readFile(jobsConfigPath, 'utf8'),
		readFile(originConfigPath, 'utf8'),
	])
	const config = parseJsonc<JsonRecord>(jobsSource)
	const originConfig = parseJsonc<JsonRecord>(originSource)
	const envRecord = readEnvRecord(config, jobsConfigPath, envName)
	envRecord.name = readJobsServiceName(originConfig, originConfigPath, envName)
	pinHostService(
		envRecord,
		readOriginLocalName(originConfig, originConfigPath, envName),
		jobsConfigPath,
		envName,
	)

	const outputPath = path.join(
		path.dirname(jobsConfigPath),
		'wrangler-local-dev.generated.json',
	)
	await writeFile(outputPath, `${JSON.stringify(config, null, '\t')}\n`)
	return outputPath
}

function readEnvRecord(
	config: JsonRecord,
	configPath: string,
	envName: string,
) {
	const envs = config.env
	if (!envs || typeof envs !== 'object') {
		throw new Error(`${configPath} is missing "env".`)
	}
	const selected = (envs as JsonRecord)[envName]
	if (!selected || typeof selected !== 'object') {
		throw new Error(`${configPath} is missing "env.${envName}".`)
	}
	return selected as JsonRecord
}

function readJobsServiceName(
	originConfig: JsonRecord,
	originConfigPath: string,
	envName: string,
) {
	const envRecord = readEnvRecord(originConfig, originConfigPath, envName)
	const services = envRecord.services
	if (Array.isArray(services)) {
		for (const service of services) {
			if (!service || typeof service !== 'object') continue
			const record = service as JsonRecord
			if (record.binding !== 'JOBS') continue
			if (typeof record.service === 'string' && record.service.length > 0) {
				return record.service
			}
		}
	}
	throw new Error(
		`${originConfigPath} env.${envName} is missing a JOBS service binding.`,
	)
}

function readOriginLocalName(
	originConfig: JsonRecord,
	originConfigPath: string,
	envName: string,
) {
	const envRecord = readEnvRecord(originConfig, originConfigPath, envName)
	if (typeof envRecord.name === 'string' && envRecord.name.length > 0) {
		return envRecord.name
	}
	const topLevelName = originConfig.name
	if (typeof topLevelName !== 'string' || topLevelName.length === 0) {
		throw new Error(`${originConfigPath} is missing "name".`)
	}
	return `${topLevelName}-${envName}`
}

function pinHostService(
	envRecord: JsonRecord,
	hostName: string,
	configPath: string,
	envName: string,
) {
	const services = envRecord.services
	if (!Array.isArray(services)) {
		throw new Error(`${configPath} env.${envName} is missing "services".`)
	}
	for (const service of services) {
		if (!service || typeof service !== 'object') continue
		const record = service as JsonRecord
		if (record.binding !== 'HOST') continue
		record.service = hostName
		return
	}
	throw new Error(
		`${configPath} env.${envName} is missing a HOST service binding.`,
	)
}
