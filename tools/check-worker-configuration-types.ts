import { readFile, rm } from 'node:fs/promises'
import { isExecutedDirectly } from './node-runtime.ts'
import {
	generateWorkerConfigurationTypes,
	normalizeWorkerConfigurationTypes,
	workerConfigurationTypesCheckPath,
	workerConfigurationTypesPath,
} from './generate-worker-configuration-types.ts'

export function workerConfigurationTypesDrift(
	committed: string,
	generated: string,
) {
	if (committed === generated) return null
	const committedLines = committed.split('\n')
	const generatedLines = generated.split('\n')
	const samples: Array<string> = []
	const limit = Math.max(committedLines.length, generatedLines.length)
	for (let index = 0; index < limit && samples.length < 12; index += 1) {
		const before = committedLines[index]
		const after = generatedLines[index]
		if (before === after) continue
		samples.push(
			`line ${String(index + 1)}\n- ${before ?? '<missing>'}\n+ ${after ?? '<missing>'}`,
		)
	}
	return samples
}

export async function checkWorkerConfigurationTypes() {
	let generated: string
	try {
		generated = await generateWorkerConfigurationTypes(
			workerConfigurationTypesCheckPath,
		)
	} finally {
		await rm(workerConfigurationTypesCheckPath, { force: true })
	}
	const normalized = normalizeWorkerConfigurationTypes(
		generated,
		workerConfigurationTypesCheckPath,
		workerConfigurationTypesPath,
	)
	const committed = await readFile(workerConfigurationTypesPath, 'utf8')
	const drift = workerConfigurationTypesDrift(committed, normalized)
	if (!drift) return
	console.error(
		`${workerConfigurationTypesPath} does not match \`npm run generate-types\`.`,
	)
	console.error(
		'Run `npm run generate-types` and commit that file. Do not hand-edit it.',
	)
	for (const sample of drift) console.error(sample)
	process.exitCode = 1
}

if (isExecutedDirectly(import.meta.url)) {
	await checkWorkerConfigurationTypes()
}
