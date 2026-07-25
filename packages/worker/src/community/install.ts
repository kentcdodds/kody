import { refreshSavedPackageProjection } from '#worker/package-registry/service.ts'
import { runRepoChecks, type RepoCheckResult } from '#worker/repo/checks.ts'
import { normalizeRepoWorkspacePath } from '#worker/repo/manifest.ts'
import { forkCommunityListing } from './service.ts'
import { type CommunityForkActor, type CrossScopeReference } from './types.ts'

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
}): Promise<InstallCommunityListingResult> {
	const fork = await forkCommunityListing({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		expectedPackageScope: input.expectedPackageScope,
		listingId: input.listingId,
		kodyId: input.kodyId,
		expectedPinnedCommit: input.expectedPinnedCommit,
		actor: input.actor ?? 'human',
	})
	const summary: InstallForkSummary = {
		forkId: fork.forkId,
		packageId: fork.packageId,
		sourceId: fork.sourceId,
		targetKodyId: fork.targetKodyId,
		targetName: fork.targetName,
		originCommit: fork.originCommit,
	}

	// Community snapshots are always rooted at package.json (community publish
	// reads the owner package's source root), and forked entity sources are
	// created with the default manifest path and root — see ensureEntitySource
	// in forkCommunityListing.
	const checks = await runRepoChecks({
		workspace: createSnapshotFilesWorkspace(fork.files),
		manifestPath: 'package.json',
		sourceRoot: '/',
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		expectedPackageScope: input.expectedPackageScope,
	})
	if (!checks.ok) {
		return {
			...summary,
			status: 'adaptation_required',
			failedChecks: checks.results.filter((check) => !check.ok),
			crossScopeReferences: fork.crossScopeReferences,
		}
	}

	await refreshSavedPackageProjection({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		userEmail: input.userEmail,
		packageId: fork.packageId,
		sourceId: fork.sourceId,
	})
	return {
		...summary,
		status: 'installed',
	}
}
