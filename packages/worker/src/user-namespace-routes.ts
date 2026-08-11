/**
 * The `/@owner/…` namespace is shared by machine surfaces (package apps,
 * connector sessions, webhook ingress, the invocation API) and by the canonical
 * public package URL `/@owner/kody-id`, which the worker hands to Remix.
 *
 * Every machine surface names a target after its namespace segment, so they all
 * live at three segments or deeper. Requiring that depth keeps the two-segment
 * public form addressable even when a `kody.id` happens to spell a namespace.
 */

const userNamespaceSegments = new Set(['packages', 'connectors', 'webhooks'])

function splitUserNamespacePath(pathname: string) {
	const parts = pathname.split('/').filter(Boolean)
	return parts[0]?.startsWith('@') ? parts : null
}

export function isNamespacedPackageInvocationEndpointPath(pathname: string) {
	const parts = splitUserNamespacePath(pathname)
	return parts?.[1] === 'api' && parts[2] === 'package-invocations'
}

export function isNamespacedAppEndpointPath(pathname: string) {
	const parts = splitUserNamespacePath(pathname)
	if (!parts || parts.length < 3) return false
	return userNamespaceSegments.has(parts[1] ?? '')
}
