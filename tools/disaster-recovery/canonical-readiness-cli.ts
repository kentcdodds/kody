import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	assessCanonicalReadiness,
	renderReadinessReport,
} from './canonical-readiness.ts'
import { sha256 } from './canonical-json.ts'

const uriSchemePattern = /^[a-z][a-z0-9+.-]*:/i

function resolveLocalArtifactPath(
	uri: string,
	evidenceFilePath: string,
): string {
	if (uri.startsWith('file:')) {
		const parsed = new URL(uri)
		if (parsed.protocol !== 'file:') {
			throw new Error(`Artifact URI is not local: ${uri}`)
		}
		return fileURLToPath(parsed)
	}
	if (uriSchemePattern.test(uri)) {
		throw new Error(`Artifact URI is not local: ${uri}`)
	}
	return path.resolve(path.dirname(evidenceFilePath), uri)
}

export async function verifyLocalArtifactFiles(
	evidence: unknown,
	evidenceFilePath: string,
): Promise<ReadonlyMap<string, string>> {
	if (!Array.isArray(evidence)) return new Map()
	const uris = new Set<string>()
	for (const candidate of evidence) {
		if (
			!candidate ||
			typeof candidate !== 'object' ||
			Array.isArray(candidate)
		) {
			continue
		}
		const artifacts = (candidate as Record<string, unknown>).artifacts
		if (!Array.isArray(artifacts)) continue
		for (const artifact of artifacts) {
			if (
				!artifact ||
				typeof artifact !== 'object' ||
				Array.isArray(artifact)
			) {
				continue
			}
			const uri = (artifact as Record<string, unknown>).uri
			if (typeof uri === 'string' && uri.length > 0) uris.add(uri)
		}
	}
	const verified = new Map<string, string>()
	await Promise.all(
		[...uris].map(async (uri) => {
			const file = resolveLocalArtifactPath(uri, evidenceFilePath)
			verified.set(uri, sha256(await readFile(file)))
		}),
	)
	return verified
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	if (argv.length !== 2 || argv[0] !== '--evidence' || !argv[1]) {
		throw new Error(
			'Usage: canonical-readiness-cli.ts --evidence <evidence.json>',
		)
	}
	const evidence = JSON.parse(await readFile(argv[1], 'utf8')) as unknown
	const verifiedArtifactDigests = await verifyLocalArtifactFiles(
		evidence,
		argv[1],
	)
	const result = assessCanonicalReadiness(
		evidence,
		new Date(),
		verifiedArtifactDigests,
	)
	console.log(renderReadinessReport(result))
	if (!result.levels['full-service'].ready) process.exitCode = 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
	await main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
	})
}
