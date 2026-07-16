import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { buildCommunitySnapshotKvKey } from '../packages/worker/src/community/snapshot.ts'
import { type CommunitySnapshot } from '../packages/worker/src/community/types.ts'

const projectRoot = path.resolve(import.meta.dirname, '..')

// Minimal icon that passes the community SVG safety checks so seeded listings
// exercise the real icon pipeline (snapshot -> render -> R2) instead of
// logging `community-icon-load-failed` for every page view.
const e2eCommunityIconSvg =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
	'<rect width="64" height="64" rx="12" fill="#4f46e5"/>' +
	'<circle cx="32" cy="32" r="14" fill="#ffffff"/>' +
	'</svg>'

function executeE2eKvPut(key: string, value: string) {
	const result = spawnSync(
		process.execPath,
		[
			'--env-file=packages/worker/.env',
			'./wrangler-env.ts',
			'kv',
			'key',
			'put',
			key,
			value,
			'--binding',
			'BUNDLE_ARTIFACTS_KV',
			'--local',
			'--persist-to',
			'.wrangler/state/e2e',
		],
		{
			cwd: projectRoot,
			encoding: 'utf8',
			stdio: 'pipe',
			env: {
				...process.env,
				CLOUDFLARE_ENV: 'test',
			},
		},
	)
	if (result.status !== 0) {
		throw new Error(
			`Failed to execute E2E KV put:\n${result.stdout}\n${result.stderr}`,
		)
	}
}

export function seedCommunitySnapshotInE2eKv(input: {
	listingId: string
	pinnedCommit: string
	files?: Record<string, string>
}) {
	const snapshot: CommunitySnapshot = {
		version: 1,
		listingId: input.listingId,
		pinnedCommit: input.pinnedCommit,
		files: {
			'community-icon.svg': e2eCommunityIconSvg,
			...input.files,
		},
		communityIconPath: 'community-icon.svg',
		createdAt: new Date().toISOString(),
	}
	executeE2eKvPut(
		buildCommunitySnapshotKvKey(input.listingId),
		JSON.stringify(snapshot),
	)
}
