import { type Handle, type RemixNode } from 'remix/ui'
import { type SessionInfo, type SessionStatus } from './session.ts'

export type AppSessionContextValue = {
	session: SessionInfo | null
	status: SessionStatus
}

/**
 * Publishes the SSR-embedded app session (and later client refreshes) to
 * descendant routes. `/oauth/authorize` reads this so first paint can render
 * signed-in vs login without a second `/session` round trip.
 */
export function AppSessionProvider(
	handle: Handle<
		{
			session: SessionInfo | null
			status: SessionStatus
			children?: RemixNode
		},
		AppSessionContextValue
	>,
) {
	function publish() {
		handle.context.set({
			session: handle.props.session,
			status: handle.props.status,
		})
	}

	publish()

	return () => {
		publish()
		return handle.props.children
	}
}

export function readAppSession(handle: Pick<Handle, 'context'>) {
	return handle.context.get(AppSessionProvider)
}
