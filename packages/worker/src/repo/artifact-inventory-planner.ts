import {
	getArtifactsBinding,
	resolveArtifactsNamespace,
	type ArtifactRepoInfo,
} from './artifacts.ts'
import { listEntitySourcesByUser } from './entity-sources.ts'

export type ArtifactInventoryClassification =
	| 'referenced_source_root'
	| 'unreferenced_derived_repo'
	| 'unreferenced_source_like_root'
	| 'unknown_unreferenced'

export type ArtifactInventoryRepoPlan = {
	name: string
	createdAt: string
	updatedAt: string
	lastPushAt: string | null
	source: string | null
	classification: ArtifactInventoryClassification
	deleteCandidate: boolean
	reason: string
}

export type ArtifactInventoryPlan = {
	namespace: string
	totalListed: number
	totalAvailable: number
	truncated: boolean
	counts: Record<ArtifactInventoryClassification, number>
	deleteCandidateCount: number
	samples: Array<ArtifactInventoryRepoPlan>
}

function emptyCounts(): Record<ArtifactInventoryClassification, number> {
	return {
		referenced_source_root: 0,
		unreferenced_derived_repo: 0,
		unreferenced_source_like_root: 0,
		unknown_unreferenced: 0,
	}
}

function isSourceLikeRepoName(name: string) {
	return /^(package|job|skill|app)-[a-z0-9-]+$/.test(name)
}

function classifyArtifactRepo(input: {
	repo: Omit<ArtifactRepoInfo, 'remote'>
	sourceRepoNames: Set<string>
}): Omit<
	ArtifactInventoryRepoPlan,
	'name' | 'createdAt' | 'updatedAt' | 'lastPushAt' | 'source'
> {
	if (input.sourceRepoNames.has(input.repo.name)) {
		return {
			classification: 'referenced_source_root',
			deleteCandidate: false,
			reason: 'Repo is the current source root for a saved source row.',
		}
	}
	if (input.repo.source) {
		return {
			classification: 'unreferenced_derived_repo',
			deleteCandidate: true,
			reason:
				'Repo reports an Artifacts source repo but is not referenced by current source metadata.',
		}
	}
	if (isSourceLikeRepoName(input.repo.name)) {
		return {
			classification: 'unreferenced_source_like_root',
			deleteCandidate: true,
			reason:
				'Repo name looks like a Kody source root but is not referenced by current source metadata.',
		}
	}
	return {
		classification: 'unknown_unreferenced',
		deleteCandidate: false,
		reason:
			'Repo is not referenced by Kody metadata, but the name/source shape is not specific enough for automatic cleanup.',
	}
}

export async function planArtifactRepoInventory(input: {
	env: Env
	userId: string
	namespace?: string | null
	maxRepos?: number
	sampleLimit?: number
}): Promise<ArtifactInventoryPlan> {
	const namespace = resolveArtifactsNamespace(input.env, input.namespace)
	const binding = getArtifactsBinding(input.env, namespace)
	const sources = await listEntitySourcesByUser(input.env.APP_DB, input.userId)
	const sourceRepoNames = new Set(sources.map((source) => source.repo_id))
	const maxRepos = input.maxRepos ?? 1000
	const sampleLimit = input.sampleLimit ?? 50
	const counts = emptyCounts()
	const samples: Array<ArtifactInventoryRepoPlan> = []
	let totalListed = 0
	let totalAvailable = 0
	let cursor: string | undefined
	do {
		const page = await binding.list({
			limit: Math.min(100, maxRepos - totalListed),
			cursor,
		})
		totalAvailable = page.total
		for (const repo of page.repos) {
			const classification = classifyArtifactRepo({
				repo,
				sourceRepoNames,
			})
			counts[classification.classification] += 1
			const plan = {
				name: repo.name,
				createdAt: repo.createdAt,
				updatedAt: repo.updatedAt,
				lastPushAt: repo.lastPushAt,
				source: repo.source,
				...classification,
			}
			if (samples.length < sampleLimit) {
				samples.push(plan)
			}
			totalListed += 1
			if (totalListed >= maxRepos) break
		}
		cursor = page.cursor
	} while (cursor && totalListed < maxRepos)
	return {
		namespace,
		totalListed,
		totalAvailable,
		truncated: Boolean(cursor) || totalListed < totalAvailable,
		counts,
		deleteCandidateCount:
			counts.unreferenced_derived_repo + counts.unreferenced_source_like_root,
		samples,
	}
}
