import {
	ProtocolError,
	ProtocolErrorCode,
	ResourceNotFoundError,
} from '@modelcontextprotocol/server'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { resolveConnectionProfileActor } from '#worker/connection-profiles/access.ts'
import { profileGrantsReveal } from '#worker/connection-profiles/repo.ts'
import {
	buildPackageSkillsIndex,
	collectPackageSkills,
	digestUtf8,
	type PackageSkillIndexEntry,
	type PackageSkillResourceIndexEntry,
	type PackageSkillsIndex,
} from '#worker/package-registry/package-skills.ts'
import { listPlatformPackagesForSearch } from '#worker/package-registry/platform-packages.ts'
import { listSavedPackagesWithCommunityProvenanceByUserId } from '#worker/package-registry/repo.ts'
import { listAcceptedInboundSharedPackages } from '#worker/package-registry/share-grants.ts'
import {
	readPackageSkillsIndex,
	writePackageSkillsIndex,
} from '#worker/package-registry/skills-index-cache.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { listEntitySourcesByIds } from '#worker/repo/entity-sources.ts'

export const skillsResultTtlMs = 300_000
export const skillsResultCacheScope = 'private' as const

/** One visible package's skills index plus what is needed to read its files. */
export type CallerSkillsCatalogPackage = {
	ownerUserId: string
	sourceId: string
	packageId: string
	index: PackageSkillsIndex
}

export type CallerSkillsCatalog = ReadonlyArray<CallerSkillsCatalogPackage>

export type CatalogSkill = {
	package: CallerSkillsCatalogPackage
	skill: PackageSkillIndexEntry
}

export type CatalogSkillResource = {
	package: CallerSkillsCatalogPackage
	skill: PackageSkillIndexEntry
	resource: PackageSkillResourceIndexEntry
}

export type WireSkill = {
	uri: string
	frontmatter: PackageSkillIndexEntry['frontmatter']
	resources: Array<{ uri: string; digest: string; size: number }>
}

function skillsInternalError(message: string, cause?: unknown) {
	const detail =
		cause === undefined
			? ''
			: `: ${cause instanceof Error ? cause.message : String(cause)}`
	return new ProtocolError(
		ProtocolErrorCode.InternalError,
		`${message}${detail}`,
	)
}

async function listVisibleSkillPackageRecords(input: {
	env: Env
	callerContext: McpCallerContext
}): Promise<Array<SavedPackageRecord>> {
	const userId = input.callerContext.user?.userId
	if (!userId) return []
	const profileActor = await resolveConnectionProfileActor(input)
	const reveal = (packageId: string) =>
		profileGrantsReveal({
			grants: profileActor.grants,
			resourceType: 'package',
			resourceId: packageId,
		})
	const [ownRecords, sharedRecords, platformPackages] = await Promise.all([
		listSavedPackagesWithCommunityProvenanceByUserId(input.env.APP_DB, {
			userId,
		}),
		listAcceptedInboundSharedPackages({
			db: input.env.APP_DB,
			granteeUserId: userId,
		}),
		listPlatformPackagesForSearch(input.env.APP_DB),
	])
	const ownIds = new Set(ownRecords.map((record) => record.id))
	const ownNames = new Set(ownRecords.map((record) => record.name))
	const ownKodyIds = new Set(ownRecords.map((record) => record.kodyId))
	const candidates: Array<SavedPackageRecord> = [
		...ownRecords.filter((record) => !record.hidden),
		...sharedRecords.filter((record) => !ownIds.has(record.id)),
		...platformPackages
			.map((entry) => entry.record)
			.filter(
				(record) =>
					!ownNames.has(record.name) && !ownKodyIds.has(record.kodyId),
			),
	]
	const seen = new Set<string>()
	return candidates.filter((record) => {
		if (!record.hasSkills || !reveal(record.id) || seen.has(record.id)) {
			return false
		}
		seen.add(record.id)
		return true
	})
}

async function rebuildPackageSkillsIndex(input: {
	env: Env
	callerContext: McpCallerContext
	record: SavedPackageRecord
	publishedCommit: string
}): Promise<PackageSkillsIndex> {
	const { record } = input
	try {
		const loaded = await loadPackageSourceBySourceId({
			env: input.env,
			baseUrl: input.callerContext.baseUrl,
			userId: record.userId,
			sourceId: record.sourceId,
		})
		const skills = await collectPackageSkills({
			files: loaded.files,
			// Scoped package.json name (`@owner/slug`), not the leaf kody.id.
			kodyId: loaded.manifest.name,
		})
		const index = buildPackageSkillsIndex({
			packageId: record.id,
			kodyId: record.name,
			publishedCommit: input.publishedCommit,
			skills,
		})
		await writePackageSkillsIndex({
			env: input.env,
			userId: record.userId,
			index,
		})
		return index
	} catch (error) {
		throw skillsInternalError(
			`Failed to rebuild the skills index for package "${record.kodyId}"`,
			error,
		)
	}
}

/**
 * Every package-shipped skill the caller can see, read from the per-version
 * skills index in KV. Packages that report `hasSkills` but have no index yet
 * (published before the extension shipped) are rebuilt from the published
 * snapshot; a failed rebuild fails the whole request instead of silently
 * dropping skills.
 */
export async function loadCallerSkillsCatalog(input: {
	env: Env
	callerContext: McpCallerContext
}): Promise<CallerSkillsCatalog> {
	const records = await listVisibleSkillPackageRecords(input)
	if (records.length === 0) return []
	const sources = await listEntitySourcesByIds(
		input.env.APP_DB,
		records.map((record) => record.sourceId),
	)
	const publishedCommitBySourceId = new Map(
		sources.map((source) => [source.id, source.published_commit]),
	)
	const packages = await Promise.all(
		records.map(async (record) => {
			const publishedCommit = publishedCommitBySourceId.get(record.sourceId)
			if (!publishedCommit) return null
			const index =
				(await readPackageSkillsIndex({
					env: input.env,
					userId: record.userId,
					packageId: record.id,
					publishedCommit,
				})) ??
				(await rebuildPackageSkillsIndex({
					env: input.env,
					callerContext: input.callerContext,
					record,
					publishedCommit,
				}))
			return {
				ownerUserId: record.userId,
				sourceId: record.sourceId,
				packageId: record.id,
				index,
			} satisfies CallerSkillsCatalogPackage
		}),
	)
	return packages.filter(
		(entry): entry is CallerSkillsCatalogPackage => entry !== null,
	)
}

export function listCatalogSkills(catalog: CallerSkillsCatalog) {
	const seen = new Set<string>()
	const skills: Array<CatalogSkill> = []
	for (const pkg of catalog) {
		for (const skill of pkg.index.skills) {
			if (seen.has(skill.uri)) continue
			seen.add(skill.uri)
			skills.push({ package: pkg, skill })
		}
	}
	return skills
}

export function toWireSkill(skill: PackageSkillIndexEntry): WireSkill {
	return {
		uri: skill.uri,
		frontmatter: skill.frontmatter,
		resources: skill.resources.map((resource) => ({
			uri: resource.uri,
			digest: resource.digest,
			size: resource.size,
		})),
	}
}

export function listCatalogSkillResources(catalog: CallerSkillsCatalog) {
	const seen = new Set<string>()
	const resources: Array<CatalogSkillResource> = []
	for (const { package: pkg, skill } of listCatalogSkills(catalog)) {
		for (const resource of skill.resources) {
			if (seen.has(resource.uri)) continue
			seen.add(resource.uri)
			resources.push({ package: pkg, skill, resource })
		}
	}
	return resources
}

export function buildSkillsListResult(catalog: CallerSkillsCatalog) {
	return {
		resultType: 'complete' as const,
		skills: listCatalogSkills(catalog).map(({ skill }) => toWireSkill(skill)),
		ttlMs: skillsResultTtlMs,
		cacheScope: skillsResultCacheScope,
	}
}

/** Exact-match lookup on the skill's `SKILL.md` URI; unknown URIs are -32602. */
export function buildSkillsGetResult(
	catalog: CallerSkillsCatalog,
	uri: string,
) {
	const match = listCatalogSkills(catalog).find(
		({ skill }) => skill.uri === uri,
	)
	if (!match) {
		throw new ProtocolError(
			ProtocolErrorCode.InvalidParams,
			`Unknown skill URI: ${uri}`,
			{ uri },
		)
	}
	return {
		resultType: 'complete' as const,
		skill: toWireSkill(match.skill),
		ttlMs: skillsResultTtlMs,
		cacheScope: skillsResultCacheScope,
	}
}

export function buildSkillResourcesListResult(catalog: CallerSkillsCatalog) {
	return {
		resources: listCatalogSkillResources(catalog).map(({ skill, resource }) => {
			const isManifest = resource.relativePath === 'SKILL.md'
			return {
				uri: resource.uri,
				name: isManifest
					? skill.name
					: `${skill.name}/${resource.relativePath}`,
				mimeType: resource.mimeType,
				size: resource.size,
				...(isManifest ? { description: skill.frontmatter.description } : {}),
			}
		}),
	}
}

/**
 * Reads one skill file from the published snapshot and verifies it against the
 * digest and size recorded at publish time, so a snapshot that moved after the
 * index was written is reported instead of served.
 */
export async function readCatalogSkillResource(input: {
	env: Env
	callerContext: McpCallerContext
	catalog: CallerSkillsCatalog
	uri: string
}) {
	const match = listCatalogSkillResources(input.catalog).find(
		({ resource }) => resource.uri === input.uri,
	)
	if (!match) throw new ResourceNotFoundError(input.uri)
	const { resource } = match
	let content: string | undefined
	try {
		const loaded = await loadPackageSourceBySourceId({
			env: input.env,
			baseUrl: input.callerContext.baseUrl,
			userId: match.package.ownerUserId,
			sourceId: match.package.sourceId,
		})
		content = loaded.files[resource.packagePath]
	} catch (error) {
		throw skillsInternalError(
			`Failed to load skill resource "${input.uri}"`,
			error,
		)
	}
	if (content === undefined) {
		throw skillsInternalError(
			`Skill resource "${input.uri}" is missing from the published snapshot`,
		)
	}
	const { digest, size } = await digestUtf8(content)
	if (digest !== resource.digest || size !== resource.size) {
		throw skillsInternalError(
			`Skill resource "${input.uri}" does not match its published digest`,
		)
	}
	return {
		contents: [
			{
				uri: resource.uri,
				mimeType: resource.mimeType,
				text: content,
			},
		],
	}
}
