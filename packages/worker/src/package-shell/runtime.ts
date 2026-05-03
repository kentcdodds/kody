import {
	buildAuthenticatedArtifactsRemote,
	resolveSessionRepo,
} from '#worker/repo/artifacts.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import {
	type RepoSessionInfoResult,
	type RepoSessionSyncResult,
} from '#worker/repo/types.ts'
import { type z } from 'zod'
import { type repoResolvedTargetSchema } from '#mcp/capabilities/repo/repo-shared.ts'

export const packageShellDefaultDirectory = '/workspace/package'
const packageShellSessionIdPrefix = 'package-shell:'
const defaultCommandTimeoutMs = 120_000

type PackageShellOpenInput = {
	env: Env
	userId: string
	session: RepoSessionInfoResult
	resolvedTarget: z.infer<typeof repoResolvedTargetSchema>
	commandTimeoutMs?: number | null
}

type PackageShellExecInput = PackageShellOpenInput & {
	command: string
	cwd?: string | null
	syncAfter?: boolean | null
}

function getSandboxNamespace(env: Env) {
	const namespace = (env as Env & { Sandbox?: DurableObjectNamespace }).Sandbox
	if (!namespace) {
		throw new Error('Sandbox binding is not configured.')
	}
	return namespace
}

function buildPackageShellId(sessionId: string) {
	return `${packageShellSessionIdPrefix}${sessionId}`
}

async function buildPackageShellEnvironment(input: {
	env: Env
	session: RepoSessionInfoResult
}) {
	const repo = await resolveSessionRepo(input.env, {
		namespace: input.session.session_repo_namespace,
		name: input.session.session_repo_name,
	})
	const info = await repo.info()
	if (!info?.remote) {
		throw new Error('Package shell session repo remote URL is unavailable.')
	}
	const token = await repo.createToken('write', 3600)
	return {
		remote: buildAuthenticatedArtifactsRemote({
			remote: info.remote,
			token: token.plaintext,
		}),
		remoteWithoutCredentials: info.remote,
		defaultBranch: info.defaultBranch,
		tokenExpiresAt: token.expiresAt,
	}
}

function buildPackageShellInstructions(input: {
	directory: string
	defaultBranch: string
}) {
	return [
		`Use $KODY_PACKAGE_REMOTE as the authenticated git remote for this package workbench.`,
		`Use $KODY_PACKAGE_DIR (${input.directory}) as the conventional clone/worktree path.`,
		`Run normal shell commands as needed. Git, node, npm, and common Unix tools are available in the sandbox image.`,
		`Clone or update the worktree: if [ ! -d "$KODY_PACKAGE_DIR/.git" ]; then git clone "$KODY_PACKAGE_REMOTE" "$KODY_PACKAGE_DIR"; else git -C "$KODY_PACKAGE_DIR" pull --ff-only origin "$KODY_PACKAGE_DEFAULT_BRANCH"; fi`,
		`Commit and push changes to ${input.defaultBranch} when ready. Then run package_check and package_publish as separate steps.`,
		`User secrets are not exposed to the sandbox.`,
	]
}

export async function openPackageShell(input: PackageShellOpenInput) {
	const shell = await buildPackageShellEnvironment(input)
	const { getSandbox } = await import('@cloudflare/sandbox')
	const sandbox = getSandbox(
		getSandboxNamespace(input.env),
		buildPackageShellId(input.session.id),
	)
	await sandbox.setEnvVars({
		KODY_PACKAGE_REMOTE: shell.remote,
		KODY_PACKAGE_DIR: packageShellDefaultDirectory,
		KODY_PACKAGE_SESSION_ID: input.session.id,
		KODY_PACKAGE_SOURCE_ID: input.session.source_id,
		KODY_PACKAGE_SOURCE_ROOT: input.session.source_root,
		KODY_PACKAGE_DEFAULT_BRANCH: shell.defaultBranch,
	})
	const executionSession = await sandbox.createSession({
		id: input.session.id,
		cwd: '/workspace',
		commandTimeoutMs: input.commandTimeoutMs ?? defaultCommandTimeoutMs,
	})
	return {
		shell,
		executionSession,
		output: {
			session_id: input.session.id,
			resolved_target: input.resolvedTarget,
			sandbox_id: buildPackageShellId(input.session.id),
			package_dir: packageShellDefaultDirectory,
			remote: shell.remoteWithoutCredentials,
			default_branch: shell.defaultBranch,
			token_expires_at: shell.tokenExpiresAt,
			instructions: buildPackageShellInstructions({
				directory: packageShellDefaultDirectory,
				defaultBranch: shell.defaultBranch,
			}),
		},
	}
}

export async function runPackageShellCommand(input: PackageShellExecInput) {
	const opened = await openPackageShell(input)
	const result = await opened.executionSession.exec(input.command, {
		cwd: input.cwd ?? '/workspace',
		timeout: input.commandTimeoutMs ?? defaultCommandTimeoutMs,
	})
	const sync =
		input.syncAfter === false
			? null
			: await repoSessionRpc(input.env, input.session.id).syncSessionFromRemote(
					{
						sessionId: input.session.id,
						userId: input.userId,
					},
				)
	return {
		...opened.output,
		command: result.command,
		success: result.success,
		exit_code: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
		duration_ms: result.duration,
		started_at: result.timestamp,
		synced_session: sync satisfies RepoSessionSyncResult | null,
	}
}
