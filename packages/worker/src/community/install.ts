import { refreshSavedPackageProjection } from '#worker/package-registry/service.ts'
import { runRepoChecks, type RepoCheckResult } from '#worker/repo/checks.ts'
import { normalizeRepoWorkspacePath } from '#worker/repo/manifest.ts'
import {
	persistPreparedCommunityFork,
	prepareCommunityFork,
} from './service.ts'
import { type CommunityForkActor, type CrossScopeReference } from './types.ts'

type InstallProgressUpdate = {
	progress: number
	total?: number
	message?: string
}

type ReportInstallProgress = (
	update: InstallProgressUpdate,
) => void | Promise<void>

async function reportInstallProgress(
	reportProgress: ReportInstallProgress | null | undefined,
	update: InstallProgressUpdate,
) {
	if (!reportProgress) return
	await reportProgress(update)
}

function logInstallPhaseTiming(input: {
	phase: string
	durationMs: number
	listingId: string
	packageId?: string
	filesCount?: number
	status?: string
}) {
	console.info(
		JSON.stringify({
			message: 'community-phase-timing',
			...input,
		}),
	)
}

type InstallForkSummary = {
	forkId: string
	packageId: string
	sourceId: string
	targetKodyId: string
	targetName: string
	originCommit: string
}

export type InstallCommunityListingResult =
	| (InstallForkSummary & { status: 'installed' })
	| (InstallForkSummary & {
			status: 'adaptation_required'
			failedChecks: Array<RepoCheckResult>
			crossScopeReferences: Array<CrossScopeReference>
	  })

function createSnapshotFilesWorkspace(files: Record<string, string>) {
	return {
		async readFile(path: string) {
			return files[normalizeRepoWorkspacePath(path)] ?? null
		},
		async glob() {
			return Object.keys(files).map((path) => ({
				path,
				type: 'file' as const,
			}))
		},
	}
}

/**
 * One-click install: fork a community listing into the caller's scope and,
 * when the fork passes the same publish checks a repo session would run,
 * immediately publish it as a live saved package (which also schedules any
 * declared jobs and auto-starts services). When checks fail — most commonly
 * because of cross-scope `kody:@` imports that cannot resolve in the
 * installer's account — the fork is kept as an inert source so an agent can
 * resume it through `repo_open_session`, and no package is published.
 *
 * Callers are responsible for the trust gate: untrusted listings must only
 * reach this after the user explicitly acknowledged the risk.
 */
export async function installCommunityListing(input: {
	env: Env
	baseUrl: string
	userId: string
	userEmail?: string | null
	expectedPackageScope: string
	listingId: string
	kodyId?: string
	/**
	 * The pinned commit the caller's trust/acknowledgement decision was made
	 * against; the fork rejects when an owner republish moved the listing to
	 * different content in the meantime.
	 */
	expectedPinnedCommit: string
	/**
	 * Defaults to `human`: one-click install is a person clicking a button.
	 * The MCP capability passes `agent` when it drives an install itself.
	 */
	actor?: CommunityForkActor | null
	waitUntil?: (promise: Promise<unknown>) => void
	reportProgress?: ReportInstallProgress
}): Promise<InstallCommunityListingResult> {
	const installStartedAt = Date.now()
	await reportInstallProgress(input.reportProgress, {
		progress: 1,
		total: 4,
		message: 'Forking the listing into your account — source sync inbound…',
	})
	const prepareStartedAt = Date.now()
	const prepared = await prepareCommunityFork({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		expectedPackageScope: input.expectedPackageScope,
		listingId: input.listingId,
		kodyId: input.kodyId,
		expectedPinnedCommit: input.expectedPinnedCommit,
		actor: input.actor ?? 'human',
	})
	logInstallPhaseTiming({
		phase: 'install-prepare',
		durationMs: Date.now() - prepareStartedAt,
		listingId: input.listingId,
		packageId: prepared.packageId,
		filesCount: Object.keys(prepared.files).length,
	})

	// Community snapshots are always rooted at package.json (community publish
	// reads the owner package's source root), and forked entity sources are
	// created with the default manifest path and root — see ensureEntitySource
	// in persistPreparedCommunityFork.
	await reportInstallProgress(input.reportProgress, {
		progress: 2,
		total: 4,
		message:
			'Typechecking and bundling npm deps — overlapping Artifacts bootstrap…',
	})
	const overlapStartedAt = Date.now()
	const persistPromise = persistPreparedCommunityFork(prepared)
	const checksPromise = runRepoChecks({
		workspace: createSnapshotFilesWorkspace(prepared.files),
		manifestPath: 'package.json',
		sourceRoot: '/',
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		expectedPackageScope: input.expectedPackageScope,
	})
	// Overlap is safe only if both sides finish before we return. Promise.all
	// would reject as soon as checks throw and abandon an in-flight persist,
	// leaving a fork the client never received (retry then collides).
	const [persistSettled, checksSettled] = await Promise.allSettled([
		persistPromise,
		checksPromise,
	])
	logInstallPhaseTiming({
		phase: 'install-persist-and-checks',
		durationMs: Date.now() - overlapStartedAt,
		listingId: input.listingId,
		packageId:
			persistSettled.status === 'fulfilled'
				? persistSettled.value.packageId
				: prepared.packageId,
		filesCount:
			persistSettled.status === 'fulfilled'
				? persistSettled.value.filesCount
				: Object.keys(prepared.files).length,
		status:
			persistSettled.status === 'rejected'
				? 'persist-failed'
				: checksSettled.status === 'rejected'
					? 'checks-threw'
					: checksSettled.value.ok
						? 'checks-ok'
						: 'checks-failed',
	})
	if (persistSettled.status === 'rejected') {
		throw persistSettled.reason
	}
	if (checksSettled.status === 'rejected') {
		throw checksSettled.reason
	}
	const fork = persistSettled.value
	const checks = checksSettled.value
	const summary: InstallForkSummary = {
		forkId: fork.forkId,
		packageId: fork.packageId,
		sourceId: fork.sourceId,
		targetKodyId: fork.targetKodyId,
		targetName: fork.targetName,
		originCommit: fork.originCommit,
	}
	if (!checks.ok) {
		await reportInstallProgress(input.reportProgress, {
			progress: 4,
			total: 4,
			message:
				'Checks need a human/agent touch — keeping the fork inert for adaptation.',
		})
		logInstallPhaseTiming({
			phase: 'install-total',
			durationMs: Date.now() - installStartedAt,
			listingId: input.listingId,
			packageId: fork.packageId,
			status: 'adaptation_required',
		})
		return {
			...summary,
			status: 'adaptation_required',
			failedChecks: checks.results.filter((check) => !check.ok),
			crossScopeReferences: fork.crossScopeReferences,
		}
	}

	await reportInstallProgress(input.reportProgress, {
		progress: 3,
		total: 4,
		message: 'Publishing and indexing — almost ready to invoke…',
	})
	const projectionStartedAt = Date.now()
	await refreshSavedPackageProjection({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		userEmail: input.userEmail,
		packageId: fork.packageId,
		sourceId: fork.sourceId,
		sourceFiles: prepared.files,
		waitUntil: input.waitUntil,
	})
	logInstallPhaseTiming({
		phase: 'install-projection',
		durationMs: Date.now() - projectionStartedAt,
		listingId: input.listingId,
		packageId: fork.packageId,
	})
	await reportInstallProgress(input.reportProgress, {
		progress: 4,
		total: 4,
		message: 'Installed. Your new package is live.',
	})
	logInstallPhaseTiming({
		phase: 'install-total',
		durationMs: Date.now() - installStartedAt,
		listingId: input.listingId,
		packageId: fork.packageId,
		status: 'installed',
	})
	return {
		...summary,
		status: 'installed',
	}
}
