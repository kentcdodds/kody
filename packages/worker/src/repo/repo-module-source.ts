import {
	getManifestTaskEntrypointPath,
	parseRepoManifest,
} from '#worker/repo/manifest.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'

export async function readRepoModuleSource(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceId: string
	taskName?: string | null
	sessionIdPrefix: string
}) {
	const sessionId = `${input.sessionIdPrefix}-${input.sourceId}-${crypto.randomUUID()}`
	const session = repoSessionRpc(input.env, sessionId)
	let openedSessionId: string | null = null
	try {
		const opened = await session.openSession({
			sessionId,
			sourceId: input.sourceId,
			userId: input.userId,
			baseUrl: input.baseUrl,
			sourceRoot: null,
		})
		openedSessionId = opened.id
		const manifestPath =
			opened.manifest_path?.replace(/^\/+/, '') || 'kody.json'
		const manifestFile = await session.readFile({
			sessionId: opened.id,
			userId: input.userId,
			path: manifestPath,
		})
		if (!manifestFile.content) {
			throw new Error(
				`App manifest "${manifestPath}" was not found in repo session.`,
			)
		}
		const manifest = parseRepoManifest({
			content: manifestFile.content,
			manifestPath,
		})
		const taskName = input.taskName?.trim() || manifest.tasks?.[0]?.name || 'default'
		const moduleFile = await session.readFile({
			sessionId: opened.id,
			userId: input.userId,
			path: getManifestTaskEntrypointPath(manifest, taskName),
		})
		if (!moduleFile.content) {
			throw new Error(
				`App task "${taskName}" entrypoint was not found in repo session.`,
			)
		}
		return moduleFile.content
	} finally {
		if (openedSessionId) {
			await session
				.discardSession({
					sessionId: openedSessionId,
					userId: input.userId,
				})
				.catch(() => {
					// Best effort only; source resolution should preserve the original error.
				})
		}
	}
}
