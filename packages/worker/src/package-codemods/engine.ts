import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	listSavedPackagesByUserId,
	listSavedPackagesPage,
} from '#worker/package-registry/repo.ts'
import { refreshSavedPackageProjection } from '#worker/package-registry/service.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { resolveArtifactSourceHead } from '#worker/repo/artifacts.ts'
import { runRepoChecks, type RepoCheckRunResult } from '#worker/repo/checks.ts'
import { normalizeRepoWorkspacePath } from '#worker/repo/manifest.ts'
import { syncArtifactSourceSnapshot } from '#worker/repo/source-sync.ts'
import {
	createPackageCodemodRun,
	getPackageCodemodRunById,
	insertPackageCodemodRunItem,
	listPackageCodemodRunItems,
	updatePackageCodemodRunStatus,
	type PackageCodemodRunRecord,
} from './ledger.ts'
import { getPackageCodemodById } from './registry.ts'
import {
	dispatchPackageCodemodSubscriptionEvent,
	packageCodemodAppliedTopic,
	packageCodemodRevertedTopic,
} from './subscription-events.ts'
import { type PackageCodemod, type PackageCodemodFinding } from './types.ts'

export type PackageCodemodRunMode = 'scan' | 'dry-run' | 'apply' | 'revert'

export type PackageCodemodRunScope =
	| { kind: 'user'; userId: string }
	| { kind: 'fleet' }

export type PackageCodemodRunFilters = {
	userIds?: Array<string>
	packageIds?: Array<string>
}

export type PackageCodemodItemStatus =
	| 'detected'
	| 'clean'
	| 'dry_run_ok'
	| 'dry_run_new_failures'
	| 'needs_manual'
	| 'skipped_drift'
	| 'skipped_unpublished'
	| 'applied'
	| 'reverted'
	| 'failed'

export type PackageCodemodRunItemResult = {
	itemId: string
	userId: string
	packageId: string
	kodyId: string
	status: PackageCodemodItemStatus
	changedPaths: Array<string>
	findings: Array<PackageCodemodFinding>
	beforeCommit: string | null
	afterCommit: string | null
	checkSummary: { ok: boolean; newFailures: Array<string> } | null
	error: string | null
}

export type PackageCodemodRunStepResult = {
	runId: string
	codemodId: string
	mode: PackageCodemodRunMode
	items: Array<PackageCodemodRunItemResult>
	nextCursor: string | null
	summary: Partial<Record<PackageCodemodItemStatus, number>>
}

const defaultStepLimit = 20
const maxStepLimit = 50

type CodemodRevertSnapshot = {
	codemodId: string
	userId: string
	packageId: string
	beforeCommit: string | null
	files: Record<string, string>
}

function buildRevertSnapshotKvKey(itemId: string) {
	return `package-codemod-revert:${itemId}`
}

function createSnapshotFilesWorkspace(files: Record<string, string>) {
	return {
		async readFile(path: string) {
			return files[normalizeRepoWorkspacePath(path)] ?? null
		},
		async glob(_pattern: string) {
			return Object.keys(files).map((path) => ({
				path,
				type: 'file' as const,
			}))
		},
	}
}

function failureKeys(result: RepoCheckRunResult): Set<string> {
	const keys = new Set<string>()
	for (const check of result.results) {
		if (check.ok) continue
		keys.add(`${check.kind}:${check.message}`)
	}
	return keys
}

function computeCheckSummary(input: {
	before: RepoCheckRunResult
	after: RepoCheckRunResult
}) {
	const beforeFailures = failureKeys(input.before)
	const newFailures: Array<string> = []
	for (const key of failureKeys(input.after)) {
		if (!beforeFailures.has(key)) {
			newFailures.push(key)
		}
	}
	newFailures.sort((left, right) => left.localeCompare(right))
	return {
		ok: newFailures.length === 0,
		newFailures,
	}
}

function matchesFilters(
	savedPackage: SavedPackageRecord,
	filters: PackageCodemodRunFilters | undefined,
) {
	if (!filters) return true
	if (
		filters.userIds != null &&
		filters.userIds.length > 0 &&
		!filters.userIds.includes(savedPackage.userId)
	) {
		return false
	}
	if (
		filters.packageIds != null &&
		filters.packageIds.length > 0 &&
		!filters.packageIds.includes(savedPackage.id)
	) {
		return false
	}
	return true
}

function emptyItemResult(input: {
	itemId: string
	userId: string
	packageId: string
	kodyId: string
	status: PackageCodemodItemStatus
	error?: string | null
	findings?: Array<PackageCodemodFinding>
	changedPaths?: Array<string>
	beforeCommit?: string | null
	afterCommit?: string | null
	checkSummary?: PackageCodemodRunItemResult['checkSummary']
}): PackageCodemodRunItemResult {
	return {
		itemId: input.itemId,
		userId: input.userId,
		packageId: input.packageId,
		kodyId: input.kodyId,
		status: input.status,
		changedPaths: input.changedPaths ?? [],
		findings: input.findings ?? [],
		beforeCommit: input.beforeCommit ?? null,
		afterCommit: input.afterCommit ?? null,
		checkSummary: input.checkSummary ?? null,
		error: input.error ?? null,
	}
}

function incrementSummary(
	summary: Partial<Record<PackageCodemodItemStatus, number>>,
	status: PackageCodemodItemStatus,
) {
	summary[status] = (summary[status] ?? 0) + 1
}

async function ensureRun(input: {
	env: Env
	runId?: string
	codemodId: string
	mode: PackageCodemodRunMode
	scope: PackageCodemodRunScope
	initiatedByUserId: string
	filters?: PackageCodemodRunFilters
	revertOfRunId?: string
}): Promise<PackageCodemodRunRecord> {
	if (input.runId) {
		const existing = await getPackageCodemodRunById(
			input.env.APP_DB,
			input.runId,
		)
		if (!existing) {
			throw new Error(`Package codemod run "${input.runId}" was not found.`)
		}
		if (existing.codemodId !== input.codemodId) {
			throw new Error(
				`Package codemod run "${input.runId}" belongs to codemod "${existing.codemodId}", not "${input.codemodId}".`,
			)
		}
		if (existing.mode !== input.mode) {
			throw new Error(
				`Package codemod run "${input.runId}" is mode "${existing.mode}", not "${input.mode}".`,
			)
		}
		return existing
	}
	let scopeUserId: string | null
	switch (input.scope.kind) {
		case 'user':
			scopeUserId = input.scope.userId
			break
		case 'fleet':
			scopeUserId = null
			break
		default: {
			const exhaustive: never = input.scope
			throw new Error(`Unknown package codemod scope: ${String(exhaustive)}`)
		}
	}
	return await createPackageCodemodRun(input.env.APP_DB, {
		id: crypto.randomUUID(),
		codemodId: input.codemodId,
		mode: input.mode,
		scopeUserId,
		initiatedByUserId: input.initiatedByUserId,
		filtersJson: JSON.stringify(input.filters ?? {}),
		status: 'running',
		revertOfRunId: input.revertOfRunId ?? null,
	})
}

async function listCandidatePackages(input: {
	env: Env
	scope: PackageCodemodRunScope
	filters?: PackageCodemodRunFilters
	cursor: string | null
	limit: number
}): Promise<{
	packages: Array<SavedPackageRecord>
	nextCursor: string | null
}> {
	const packages: Array<SavedPackageRecord> = []
	let cursor = input.cursor
	switch (input.scope.kind) {
		case 'user': {
			const all = await listSavedPackagesByUserId(input.env.APP_DB, {
				userId: input.scope.userId,
			})
			const ordered = [...all]
				.filter((savedPackage) => matchesFilters(savedPackage, input.filters))
				.sort((left, right) => left.id.localeCompare(right.id))
			const startIndex =
				cursor == null
					? 0
					: ordered.findIndex((savedPackage) => savedPackage.id > cursor!)
			const sliceStart = startIndex < 0 ? ordered.length : startIndex
			const page = ordered.slice(sliceStart, sliceStart + input.limit)
			packages.push(...page)
			const last = page.at(-1)
			const exhausted =
				page.length < input.limit ||
				last == null ||
				ordered.every((savedPackage) => savedPackage.id <= last.id)
			return {
				packages,
				nextCursor: exhausted ? null : (last?.id ?? null),
			}
		}
		case 'fleet': {
			for (;;) {
				const page = await listSavedPackagesPage(input.env.APP_DB, {
					afterId: cursor,
					limit: input.limit,
				})
				if (page.length === 0) {
					return { packages, nextCursor: null }
				}
				for (const savedPackage of page) {
					cursor = savedPackage.id
					if (!matchesFilters(savedPackage, input.filters)) continue
					packages.push(savedPackage)
					if (packages.length >= input.limit) {
						return {
							packages,
							nextCursor: savedPackage.id,
						}
					}
				}
				if (page.length < input.limit) {
					return { packages, nextCursor: null }
				}
			}
		}
		default: {
			const exhaustive: never = input.scope
			throw new Error(`Unknown package codemod scope: ${String(exhaustive)}`)
		}
	}
}

async function detectPublishedDrift(input: {
	env: Env
	repoId: string
	publishedCommit: string
}): Promise<boolean> {
	try {
		const head = await resolveArtifactSourceHead(input.env, input.repoId)
		if (!head.commit) return true
		return head.commit !== input.publishedCommit
	} catch {
		return true
	}
}

async function persistItem(
	env: Env,
	result: PackageCodemodRunItemResult,
	runId: string,
) {
	await insertPackageCodemodRunItem(env.APP_DB, {
		id: result.itemId,
		runId,
		userId: result.userId,
		packageId: result.packageId,
		kodyId: result.kodyId,
		status: result.status,
		beforeCommit: result.beforeCommit,
		afterCommit: result.afterCommit,
		changedPaths: result.changedPaths,
		findings: result.findings,
		checkSummaryJson:
			result.checkSummary == null ? null : JSON.stringify(result.checkSummary),
		error: result.error,
	})
}

async function runChecksOnFiles(input: {
	env: Env
	baseUrl: string
	userId: string
	files: Record<string, string>
	manifestPath: string
	sourceRoot: string
}) {
	return await runRepoChecks({
		workspace: createSnapshotFilesWorkspace(input.files),
		manifestPath: input.manifestPath,
		sourceRoot: input.sourceRoot,
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
	})
}

async function processScanItem(input: {
	codemod: PackageCodemod
	savedPackage: SavedPackageRecord
	files: Record<string, string>
	beforeCommit: string | null
}): Promise<PackageCodemodRunItemResult> {
	const findings = input.codemod.detect(input.files)
	const status: PackageCodemodItemStatus =
		findings.length > 0 ? 'detected' : 'clean'
	return emptyItemResult({
		itemId: crypto.randomUUID(),
		userId: input.savedPackage.userId,
		packageId: input.savedPackage.id,
		kodyId: input.savedPackage.kodyId,
		status,
		findings,
		beforeCommit: input.beforeCommit,
	})
}

async function processTransformGates(input: {
	env: Env
	baseUrl: string
	codemod: PackageCodemod
	savedPackage: SavedPackageRecord
	files: Record<string, string>
	beforeCommit: string | null
	manifestPath: string
	sourceRoot: string
}): Promise<
	| {
			kind: 'terminal'
			result: PackageCodemodRunItemResult
	  }
	| {
			kind: 'ready'
			itemId: string
			transformedFiles: Record<string, string>
			changedPaths: Array<string>
			findings: Array<PackageCodemodFinding>
			checkSummary: { ok: boolean; newFailures: Array<string> }
	  }
> {
	const itemId = crypto.randomUUID()
	const transformed = input.codemod.transform(input.files)
	if (!transformed.changed && transformed.needsManual.length > 0) {
		return {
			kind: 'terminal',
			result: emptyItemResult({
				itemId,
				userId: input.savedPackage.userId,
				packageId: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
				status: 'needs_manual',
				findings: transformed.needsManual,
				beforeCommit: input.beforeCommit,
			}),
		}
	}
	if (!transformed.changed) {
		return {
			kind: 'terminal',
			result: emptyItemResult({
				itemId,
				userId: input.savedPackage.userId,
				packageId: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
				status: 'clean',
				findings: transformed.needsManual,
				beforeCommit: input.beforeCommit,
			}),
		}
	}
	const secondPass = input.codemod.transform(transformed.files)
	if (secondPass.changed) {
		return {
			kind: 'terminal',
			result: emptyItemResult({
				itemId,
				userId: input.savedPackage.userId,
				packageId: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
				status: 'failed',
				findings: transformed.needsManual,
				changedPaths: transformed.changedPaths,
				beforeCommit: input.beforeCommit,
				error:
					'Codemod transform is not idempotent: a second transform pass still reported changes.',
			}),
		}
	}
	const beforeChecks = await runChecksOnFiles({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.savedPackage.userId,
		files: input.files,
		manifestPath: input.manifestPath,
		sourceRoot: input.sourceRoot,
	})
	const afterChecks = await runChecksOnFiles({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.savedPackage.userId,
		files: transformed.files,
		manifestPath: input.manifestPath,
		sourceRoot: input.sourceRoot,
	})
	const checkSummary = computeCheckSummary({
		before: beforeChecks,
		after: afterChecks,
	})
	if (!checkSummary.ok) {
		return {
			kind: 'terminal',
			result: emptyItemResult({
				itemId,
				userId: input.savedPackage.userId,
				packageId: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
				status: 'dry_run_new_failures',
				findings: transformed.needsManual,
				changedPaths: transformed.changedPaths,
				beforeCommit: input.beforeCommit,
				checkSummary,
			}),
		}
	}
	return {
		kind: 'ready',
		itemId,
		transformedFiles: transformed.files,
		changedPaths: transformed.changedPaths,
		findings: transformed.needsManual,
		checkSummary,
	}
}

async function processPackageForMode(input: {
	env: Env
	baseUrl: string
	mode: PackageCodemodRunMode
	codemod: PackageCodemod
	savedPackage: SavedPackageRecord
	runId: string
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<PackageCodemodRunItemResult> {
	const loaded = await loadPackageSourceBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.savedPackage.userId,
		sourceId: input.savedPackage.sourceId,
	})
	const publishedCommit = loaded.source.published_commit
	if (publishedCommit == null) {
		return emptyItemResult({
			itemId: crypto.randomUUID(),
			userId: input.savedPackage.userId,
			packageId: input.savedPackage.id,
			kodyId: input.savedPackage.kodyId,
			status: 'skipped_unpublished',
		})
	}
	const drifted = await detectPublishedDrift({
		env: input.env,
		repoId: loaded.source.repo_id,
		publishedCommit,
	})
	if (drifted) {
		return emptyItemResult({
			itemId: crypto.randomUUID(),
			userId: input.savedPackage.userId,
			packageId: input.savedPackage.id,
			kodyId: input.savedPackage.kodyId,
			status: 'skipped_drift',
			beforeCommit: publishedCommit,
		})
	}

	switch (input.mode) {
		case 'scan':
			return await processScanItem({
				codemod: input.codemod,
				savedPackage: input.savedPackage,
				files: loaded.files,
				beforeCommit: publishedCommit,
			})
		case 'dry-run': {
			const gated = await processTransformGates({
				env: input.env,
				baseUrl: input.baseUrl,
				codemod: input.codemod,
				savedPackage: input.savedPackage,
				files: loaded.files,
				beforeCommit: publishedCommit,
				manifestPath: loaded.source.manifest_path,
				sourceRoot: loaded.source.source_root,
			})
			if (gated.kind === 'terminal') return gated.result
			return emptyItemResult({
				itemId: gated.itemId,
				userId: input.savedPackage.userId,
				packageId: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
				status: 'dry_run_ok',
				changedPaths: gated.changedPaths,
				findings: gated.findings,
				beforeCommit: publishedCommit,
				checkSummary: gated.checkSummary,
			})
		}
		case 'apply': {
			const gated = await processTransformGates({
				env: input.env,
				baseUrl: input.baseUrl,
				codemod: input.codemod,
				savedPackage: input.savedPackage,
				files: loaded.files,
				beforeCommit: publishedCommit,
				manifestPath: loaded.source.manifest_path,
				sourceRoot: loaded.source.source_root,
			})
			if (gated.kind === 'terminal') return gated.result
			const snapshot: CodemodRevertSnapshot = {
				codemodId: input.codemod.id,
				userId: input.savedPackage.userId,
				packageId: input.savedPackage.id,
				beforeCommit: publishedCommit,
				files: loaded.files,
			}
			await input.env.BUNDLE_ARTIFACTS_KV.put(
				buildRevertSnapshotKvKey(gated.itemId),
				JSON.stringify(snapshot),
			)
			const afterCommit = await syncArtifactSourceSnapshot({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: input.savedPackage.userId,
				sourceId: input.savedPackage.sourceId,
				files: gated.transformedFiles,
				destructiveOverwriteConfirmed: true,
				commitMessage: `codemod(${input.codemod.id}): ${input.codemod.description}`,
			})
			if (afterCommit == null) {
				return emptyItemResult({
					itemId: gated.itemId,
					userId: input.savedPackage.userId,
					packageId: input.savedPackage.id,
					kodyId: input.savedPackage.kodyId,
					status: 'failed',
					changedPaths: gated.changedPaths,
					findings: gated.findings,
					beforeCommit: publishedCommit,
					checkSummary: gated.checkSummary,
					error: 'syncArtifactSourceSnapshot returned no published commit.',
				})
			}
			try {
				await refreshSavedPackageProjection({
					env: input.env,
					baseUrl: input.baseUrl,
					userId: input.savedPackage.userId,
					packageId: input.savedPackage.id,
					sourceId: input.savedPackage.sourceId,
				})
			} catch (error) {
				console.error(
					JSON.stringify({
						message: 'package-codemod projection refresh failed',
						packageId: input.savedPackage.id,
						error: getErrorMessage(error),
					}),
				)
			}
			await dispatchPackageCodemodSubscriptionEvent({
				env: input.env,
				userId: input.savedPackage.userId,
				topic: packageCodemodAppliedTopic,
				codemodId: input.codemod.id,
				codemodDescription: input.codemod.description,
				packageId: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
				runId: input.runId,
				itemId: gated.itemId,
				changedPaths: gated.changedPaths,
				beforeCommit: publishedCommit,
				afterCommit,
				waitUntil: input.waitUntil,
			})
			return emptyItemResult({
				itemId: gated.itemId,
				userId: input.savedPackage.userId,
				packageId: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
				status: 'applied',
				changedPaths: gated.changedPaths,
				findings: gated.findings,
				beforeCommit: publishedCommit,
				afterCommit,
				checkSummary: gated.checkSummary,
			})
		}
		case 'revert':
			throw new Error('processPackageForMode does not handle revert mode.')
		default: {
			const exhaustive: never = input.mode
			throw new Error(`Unknown package codemod mode: ${String(exhaustive)}`)
		}
	}
}

async function processRevertStep(input: {
	env: Env
	baseUrl: string
	codemod: PackageCodemod
	run: PackageCodemodRunRecord
	scope: PackageCodemodRunScope
	cursor: string | null
	limit: number
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<PackageCodemodRunStepResult> {
	if (!input.run.revertOfRunId) {
		throw new Error('revert mode requires revertOfRunId on the run.')
	}
	const items: Array<PackageCodemodRunItemResult> = []
	const summary: Partial<Record<PackageCodemodItemStatus, number>> = {}
	let cursor = input.cursor
	for (;;) {
		const page = await listPackageCodemodRunItems(input.env.APP_DB, {
			runId: input.run.revertOfRunId,
			afterId: cursor,
			limit: input.limit,
			status: 'applied',
		})
		if (page.length === 0) {
			await updatePackageCodemodRunStatus(input.env.APP_DB, {
				id: input.run.id,
				status: 'completed',
			})
			return {
				runId: input.run.id,
				codemodId: input.codemod.id,
				mode: 'revert',
				items,
				nextCursor: null,
				summary,
			}
		}
		for (const priorItem of page) {
			cursor = priorItem.id
			if (
				input.scope.kind === 'user' &&
				priorItem.userId !== input.scope.userId
			) {
				continue
			}
			if (input.scope.kind !== 'user' && input.scope.kind !== 'fleet') {
				const exhaustive: never = input.scope
				throw new Error(`Unknown package codemod scope: ${String(exhaustive)}`)
			}
			const itemId = crypto.randomUUID()
			let result: PackageCodemodRunItemResult
			try {
				const raw = await input.env.BUNDLE_ARTIFACTS_KV.get(
					buildRevertSnapshotKvKey(priorItem.id),
				)
				if (raw == null) {
					result = emptyItemResult({
						itemId,
						userId: priorItem.userId,
						packageId: priorItem.packageId,
						kodyId: priorItem.kodyId,
						status: 'failed',
						beforeCommit: priorItem.afterCommit,
						error: `Missing revert snapshot for item "${priorItem.id}".`,
					})
				} else {
					const snapshot = JSON.parse(raw) as CodemodRevertSnapshot
					const savedPackage = (
						await listSavedPackagesByUserId(input.env.APP_DB, {
							userId: priorItem.userId,
						})
					).find((candidate) => candidate.id === priorItem.packageId)
					if (!savedPackage) {
						result = emptyItemResult({
							itemId,
							userId: priorItem.userId,
							packageId: priorItem.packageId,
							kodyId: priorItem.kodyId,
							status: 'failed',
							error: `Saved package "${priorItem.packageId}" was not found for revert.`,
						})
					} else {
						const afterCommit = await syncArtifactSourceSnapshot({
							env: input.env,
							baseUrl: input.baseUrl,
							userId: priorItem.userId,
							sourceId: savedPackage.sourceId,
							files: snapshot.files,
							destructiveOverwriteConfirmed: true,
							commitMessage: `revert codemod(${input.codemod.id})`,
						})
						if (afterCommit == null) {
							result = emptyItemResult({
								itemId,
								userId: priorItem.userId,
								packageId: priorItem.packageId,
								kodyId: priorItem.kodyId,
								status: 'failed',
								error:
									'syncArtifactSourceSnapshot returned no published commit.',
							})
						} else {
							try {
								await refreshSavedPackageProjection({
									env: input.env,
									baseUrl: input.baseUrl,
									userId: priorItem.userId,
									packageId: priorItem.packageId,
									sourceId: savedPackage.sourceId,
								})
							} catch (error) {
								console.error(
									JSON.stringify({
										message: 'package-codemod revert projection refresh failed',
										packageId: priorItem.packageId,
										error: getErrorMessage(error),
									}),
								)
							}
							await dispatchPackageCodemodSubscriptionEvent({
								env: input.env,
								userId: priorItem.userId,
								topic: packageCodemodRevertedTopic,
								codemodId: input.codemod.id,
								codemodDescription: input.codemod.description,
								packageId: priorItem.packageId,
								kodyId: priorItem.kodyId,
								runId: input.run.id,
								itemId,
								changedPaths: priorItem.changedPaths,
								beforeCommit: priorItem.afterCommit,
								afterCommit,
								waitUntil: input.waitUntil,
							})
							result = emptyItemResult({
								itemId,
								userId: priorItem.userId,
								packageId: priorItem.packageId,
								kodyId: priorItem.kodyId,
								status: 'reverted',
								changedPaths: priorItem.changedPaths,
								beforeCommit: priorItem.afterCommit,
								afterCommit,
							})
						}
					}
				}
			} catch (error) {
				result = emptyItemResult({
					itemId,
					userId: priorItem.userId,
					packageId: priorItem.packageId,
					kodyId: priorItem.kodyId,
					status: 'failed',
					error: getErrorMessage(error),
				})
			}
			await persistItem(input.env, result, input.run.id)
			items.push(result)
			incrementSummary(summary, result.status)
			if (items.length >= input.limit) {
				return {
					runId: input.run.id,
					codemodId: input.codemod.id,
					mode: 'revert',
					items,
					nextCursor: cursor,
					summary,
				}
			}
		}
		if (page.length < input.limit) {
			await updatePackageCodemodRunStatus(input.env.APP_DB, {
				id: input.run.id,
				status: 'completed',
			})
			return {
				runId: input.run.id,
				codemodId: input.codemod.id,
				mode: 'revert',
				items,
				nextCursor: null,
				summary,
			}
		}
	}
}

export async function runPackageCodemodStep(input: {
	env: Env
	baseUrl: string
	initiatedByUserId: string
	codemodId: string
	mode: PackageCodemodRunMode
	scope: PackageCodemodRunScope
	filters?: PackageCodemodRunFilters
	runId?: string
	cursor?: string | null
	limit?: number
	revertOfRunId?: string
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<PackageCodemodRunStepResult> {
	const codemod = getPackageCodemodById(input.codemodId)
	if (!codemod) {
		throw new Error(`Unknown package codemod "${input.codemodId}".`)
	}
	const limit = Math.min(
		Math.max(input.limit ?? defaultStepLimit, 1),
		maxStepLimit,
	)
	switch (input.mode) {
		case 'scan':
		case 'dry-run':
		case 'apply':
		case 'revert':
			break
		default: {
			const exhaustive: never = input.mode
			throw new Error(`Unknown package codemod mode: ${String(exhaustive)}`)
		}
	}
	if (input.mode === 'revert' && !input.revertOfRunId && !input.runId) {
		throw new Error('revert mode requires revertOfRunId.')
	}
	const run = await ensureRun({
		env: input.env,
		runId: input.runId,
		codemodId: input.codemodId,
		mode: input.mode,
		scope: input.scope,
		initiatedByUserId: input.initiatedByUserId,
		filters: input.filters,
		revertOfRunId: input.revertOfRunId,
	})
	if (input.mode === 'revert') {
		return await processRevertStep({
			env: input.env,
			baseUrl: input.baseUrl,
			codemod,
			run,
			scope: input.scope,
			cursor: input.cursor ?? null,
			limit,
			waitUntil: input.waitUntil,
		})
	}

	const { packages, nextCursor } = await listCandidatePackages({
		env: input.env,
		scope: input.scope,
		filters: input.filters,
		cursor: input.cursor ?? null,
		limit,
	})
	const items: Array<PackageCodemodRunItemResult> = []
	const summary: Partial<Record<PackageCodemodItemStatus, number>> = {}
	for (const savedPackage of packages) {
		let result: PackageCodemodRunItemResult
		try {
			result = await processPackageForMode({
				env: input.env,
				baseUrl: input.baseUrl,
				mode: input.mode,
				codemod,
				savedPackage,
				runId: run.id,
				waitUntil: input.waitUntil,
			})
		} catch (error) {
			result = emptyItemResult({
				itemId: crypto.randomUUID(),
				userId: savedPackage.userId,
				packageId: savedPackage.id,
				kodyId: savedPackage.kodyId,
				status: 'failed',
				error: getErrorMessage(error),
			})
		}
		await persistItem(input.env, result, run.id)
		items.push(result)
		incrementSummary(summary, result.status)
	}
	if (nextCursor == null) {
		await updatePackageCodemodRunStatus(input.env.APP_DB, {
			id: run.id,
			status: 'completed',
		})
	}
	return {
		runId: run.id,
		codemodId: input.codemodId,
		mode: input.mode,
		items,
		nextCursor,
		summary,
	}
}
