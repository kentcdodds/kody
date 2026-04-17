import {
	type EntitySourceRow,
	type RepoSessionInfoResult,
	type RepoSessionRow,
	type RepoSessionTreeResult,
} from './types.ts'

function normalizeUnknownTreeChild(
	child: unknown,
	parentPath: string,
): {
	path: string
	name: string
	type: 'file' | 'directory' | 'symlink'
	size: number
	children?: Array<unknown>
} {
	const input =
		child && typeof child === 'object'
			? (child as Record<string, unknown>)
			: ({} as Record<string, unknown>)
	return {
		path: typeof input.path === 'string' ? input.path : `${parentPath}/unknown`,
		name: typeof input.name === 'string' ? input.name : 'unknown',
		type:
			input.type === 'file' ||
			input.type === 'directory' ||
			input.type === 'symlink'
				? input.type
				: 'file',
		size: typeof input.size === 'number' ? input.size : 0,
		children: Array.isArray(input.children)
			? (input.children as Array<unknown>)
			: undefined,
	}
}

export function resolveRepoWorkspacePath(
	path: string,
	workspacePrefix: string,
) {
	const trimmed = path.trim()
	if (!trimmed) {
		throw new Error('A non-empty repo path is required.')
	}
	if (
		trimmed === workspacePrefix ||
		trimmed.startsWith(`${workspacePrefix}/`)
	) {
		return trimmed
	}
	return `${workspacePrefix}/${trimmed.replace(/^\/+/, '')}`
}

export function toExternalRepoPath(path: string, workspacePrefix: string) {
	return path.startsWith(`${workspacePrefix}/`)
		? path.slice(workspacePrefix.length + 1)
		: path
}

export function toRepoSessionTreeResult(input: {
	node: {
		path: string
		name: string
		type: 'file' | 'directory' | 'symlink'
		size: number
		children?: Array<unknown>
	}
	workspacePrefix: string
}): RepoSessionTreeResult {
	return {
		path: toExternalRepoPath(input.node.path, input.workspacePrefix),
		name: input.node.name,
		type: input.node.type,
		size: input.node.size,
		children: input.node.children?.map(
			(child): RepoSessionTreeResult =>
				toRepoSessionTreeResult({
					node: normalizeUnknownTreeChild(child, input.node.path),
					workspacePrefix: input.workspacePrefix,
				}),
		),
	}
}

export function toRepoSessionInfoResult(
	session: RepoSessionRow,
	source: EntitySourceRow,
): RepoSessionInfoResult {
	return {
		id: session.id,
		source_id: session.source_id,
		source_root: session.source_root,
		base_commit: session.base_commit,
		session_repo_id: session.session_repo_id,
		session_repo_name: session.session_repo_name,
		session_repo_namespace: session.session_repo_namespace,
		conversation_id: session.conversation_id,
		last_checkpoint_commit: session.last_checkpoint_commit,
		last_check_run_id: session.last_check_run_id,
		last_check_tree_hash: session.last_check_tree_hash,
		expires_at: session.expires_at,
		created_at: session.created_at,
		updated_at: session.updated_at,
		published_commit: source.published_commit,
		manifest_path: source.manifest_path,
		entity_type: source.entity_kind,
	}
}
