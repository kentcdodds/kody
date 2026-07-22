import { readFile } from 'node:fs/promises'
import {
	type ResourceEvidence,
	assessCanonicalReadiness,
	renderReadinessReport,
} from './canonical-readiness.ts'

export async function main(argv = process.argv.slice(2)): Promise<void> {
	if (argv.length !== 2 || argv[0] !== '--evidence' || !argv[1]) {
		throw new Error(
			'Usage: canonical-readiness-cli.ts --evidence <evidence.json>',
		)
	}
	const evidence = JSON.parse(
		await readFile(argv[1], 'utf8'),
	) as Array<ResourceEvidence>
	const result = assessCanonicalReadiness(evidence)
	console.log(renderReadinessReport(result))
	if (!result.levels['full-service'].ready) process.exitCode = 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
	await main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
	})
}
