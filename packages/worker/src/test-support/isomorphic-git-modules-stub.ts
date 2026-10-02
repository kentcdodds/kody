/**
 * Node-test stand-in for `./node_modules/.kody-generated/isomorphic-git.mjs`.
 * Re-exports the installed packages so `vi.mock('isomorphic-git')` /
 * `vi.mock('isomorphic-git/http/web')` still apply. Vitest mock factories
 * sometimes surface as `{ default: … }` namespaces when pulled through this
 * alias, so unwrap both shapes.
 */
import * as gitNamespace from 'isomorphic-git'
import * as httpNamespace from 'isomorphic-git/http/web'

function unwrapDefault<T>(mod: T | { default: T }): T {
	if (
		mod &&
		typeof mod === 'object' &&
		'default' in mod &&
		(mod as { default: unknown }).default != null
	) {
		return (mod as { default: T }).default
	}
	return mod as T
}

export const git = unwrapDefault(
	gitNamespace as typeof gitNamespace | { default: typeof gitNamespace },
)
export const http = unwrapDefault(
	httpNamespace as typeof httpNamespace | { default: typeof httpNamespace },
)
