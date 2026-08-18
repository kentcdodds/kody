import {
	type PackageCodemod,
	type PackageCodemodFinding,
	type PackageCodemodTransformResult,
} from '../types.ts'

export const remoteConnectorToMcpServerCodemodId =
	'0005-remote-connector-to-mcp-server'

/**
 * Clear `kody.remote` accessors and Kody remote-connector capability ids
 * (`remote:<name>:<tool>`). Ambiguous `remote` mentions (variables, prose
 * capability ids that are not clearly Kody's) are reported for manual review.
 */

const textFilePattern =
	/\.(?:[cm]?[jt]s|[jt]sx|json|jsonc|md|mdx|txt|html|css|ya?ml|toml)$/

const rewriteAccessorMessage =
	'References kody.remote; rewrite accessors to kody.mcp (home automation and other outbound tools are normal MCP servers).'

const rewriteCapabilityIdMessage =
	'References a Kody remote-connector capability id (remote:<name>:<tool>); rewrite to mcp:<name>:<tool>.'

const manualAmbiguousRemoteMessage =
	'Mentions remote in a way that may mean the retired kody.remote namespace or remote-connector capability ids; review and update manually.'

/** `kody.remote["name"]` / `kody.remote['name']` / `kody.remote.name` */
const kodyRemoteMemberPattern =
	/\bkody\.remote(?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\[\s*(?:'[^']*'|"[^"]*")\s*\])/g

/** `kody.remote[` with a non-literal expression receiver */
const kodyRemoteComputedPattern = /\bkody\.remote\s*\[/g

/** Capability id `remote:<name>:<tool>` — name matches instance naming rules. */
const remoteCapabilityIdPattern =
	/\bremote:([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?):([A-Za-z0-9_.:-]+)\b/g

/** Ambiguous leftover after rewrites: bare `kody.remote` or `remote:` prefix. */
const ambiguousRemotePattern = /\bkody\.remote\b|\bremote:[a-z0-9]/

function listTextFiles(files: Record<string, string>) {
	return Object.entries(files)
		.filter(
			([path, source]) =>
				textFilePattern.test(path) && typeof source === 'string',
		)
		.sort(([left], [right]) => left.localeCompare(right))
}

function rewriteSource(source: string) {
	let next = source.replaceAll(kodyRemoteMemberPattern, (match) =>
		match.replace('kody.remote', 'kody.mcp'),
	)
	next = next.replaceAll(kodyRemoteComputedPattern, (match) =>
		match.replace('kody.remote', 'kody.mcp'),
	)
	next = next.replaceAll(
		remoteCapabilityIdPattern,
		(_match, name: string, tool: string) => `mcp:${name}:${tool}`,
	)
	return next
}

function sourceNeedsRewrite(source: string) {
	kodyRemoteMemberPattern.lastIndex = 0
	kodyRemoteComputedPattern.lastIndex = 0
	remoteCapabilityIdPattern.lastIndex = 0
	return (
		kodyRemoteMemberPattern.test(source) ||
		kodyRemoteComputedPattern.test(source) ||
		remoteCapabilityIdPattern.test(source)
	)
}

function sourceNeedsManual(source: string) {
	ambiguousRemotePattern.lastIndex = 0
	return ambiguousRemotePattern.test(source)
}

function detectRemoteConnectorToMcpServer(
	files: Record<string, string>,
): Array<PackageCodemodFinding> {
	const findings: Array<PackageCodemodFinding> = []
	for (const [path, source] of listTextFiles(files)) {
		kodyRemoteMemberPattern.lastIndex = 0
		kodyRemoteComputedPattern.lastIndex = 0
		remoteCapabilityIdPattern.lastIndex = 0
		const hasAccessor =
			kodyRemoteMemberPattern.test(source) ||
			kodyRemoteComputedPattern.test(source)
		const hasCapabilityId = remoteCapabilityIdPattern.test(source)
		if (hasAccessor) {
			findings.push({ path, message: rewriteAccessorMessage })
		} else if (hasCapabilityId) {
			findings.push({ path, message: rewriteCapabilityIdMessage })
		} else if (sourceNeedsManual(source)) {
			findings.push({ path, message: manualAmbiguousRemoteMessage })
		}
	}
	findings.sort((left, right) =>
		(left.path ?? '').localeCompare(right.path ?? ''),
	)
	return findings
}

function transformRemoteConnectorToMcpServer(
	files: Record<string, string>,
): PackageCodemodTransformResult {
	const nextFiles: Record<string, string> = { ...files }
	const changedPaths: Array<string> = []
	const needsManual: Array<PackageCodemodFinding> = []
	for (const [path, source] of listTextFiles(files)) {
		const rewritten = rewriteSource(source)
		if (rewritten !== source) {
			nextFiles[path] = rewritten
			changedPaths.push(path)
		}
		if (sourceNeedsManual(rewritten)) {
			needsManual.push({ path, message: manualAmbiguousRemoteMessage })
		}
	}
	changedPaths.sort((left, right) => left.localeCompare(right))
	needsManual.sort((left, right) =>
		(left.path ?? '').localeCompare(right.path ?? ''),
	)
	return {
		files: nextFiles,
		changed: changedPaths.length > 0,
		changedPaths,
		needsManual,
	}
}

/**
 * Retire kody.remote / remote:<name>:<tool> in favor of kody.mcp /
 * mcp:<name>:<tool>. Kept registered while published packages may still
 * reference the deleted remote-connector surface.
 */
export const remoteConnectorToMcpServerCodemod = {
	id: remoteConnectorToMcpServerCodemodId,
	description:
		'Rewrite kody.remote accessors and remote:<name>:<tool> capability ids to kody.mcp / mcp:<name>:<tool>; flag ambiguous remote mentions for manual review.',
	detect: detectRemoteConnectorToMcpServer,
	transform: transformRemoteConnectorToMcpServer,
} satisfies PackageCodemod
