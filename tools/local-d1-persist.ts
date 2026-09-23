/**
 * Repo-root Miniflare directory shared by Vite (`persistState.path`) and
 * local `wrangler d1` commands (`--persist-to`).
 *
 * Without `--persist-to`, Wrangler stores state under
 * `<dirname(config)>/.wrangler/state`. That puts APP_DB and AUDIT_DB beside
 * `packages/worker/wrangler.jsonc` and JOBS_DB beside
 * `packages/jobs-worker/wrangler.jsonc`, while Vite opens this directory.
 */
export const defaultLocalD1PersistPath = '.wrangler/state'

export function resolveLocalD1PersistPath(
	input: {
		explicit?: string | null
		env?: NodeJS.ProcessEnv
	} = {},
) {
	const explicit = input.explicit?.trim()
	if (explicit) return explicit
	const fromEnv = (input.env ?? process.env).WRANGLER_PERSIST_TO?.trim()
	if (fromEnv) return fromEnv
	return defaultLocalD1PersistPath
}
