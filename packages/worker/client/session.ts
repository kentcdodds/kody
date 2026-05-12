export type SessionInfo = {
	email: string
	username: string
}

export type SessionStatus = 'idle' | 'loading' | 'ready'

export function getSessionDisplayName(session: SessionInfo | null) {
	return session?.username || session?.email || ''
}

export async function fetchSessionInfo(
	signal?: AbortSignal,
): Promise<SessionInfo | null> {
	try {
		const response = await fetch('/session', {
			headers: { Accept: 'application/json' },
			credentials: 'include',
			signal,
		})
		if (signal?.aborted) return null
		const payload = await response.json().catch(() => null)
		const email =
			response.ok && payload?.ok && typeof payload?.session?.email === 'string'
				? payload.session.email.trim()
				: ''
		const username =
			response.ok &&
			payload?.ok &&
			typeof payload?.session?.username === 'string'
				? payload.session.username.trim()
				: ''
		return email ? { email, username } : null
	} catch {
		return null
	}
}
