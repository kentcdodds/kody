/**
 * One definition of "this OAuth connection is connected" for credential list
 * status, candidate resolution, and personal-credential usability.
 *
 * `connected_at` is stamped on every successful token persist
 * (`COALESCE` so refreshes keep the first connect time), on platform-lane
 * connection upsert, and by the backfill migration for rows that already held
 * tokens. Auth failure is a separate overlay on list status only.
 */

/** SQL predicate matching {@link isIntegrationConnected} for a column. */
export function integrationConnectedSql(column = 'connected_at'): string {
	return `${column} IS NOT NULL`
}

export function isIntegrationConnected(
	connectedAt: string | null | undefined,
): boolean {
	return connectedAt != null
}

export function oauthCredentialListStatus(input: {
	connectedAt: string | null
	authFailedAt: string | null
	authFailedReason: string | null
}): {
	status: 'ok' | 'needs_attention'
	statusMessage: string | null
} {
	const connected = isIntegrationConnected(input.connectedAt)
	const failed = input.authFailedAt != null
	if (connected && !failed) {
		return { status: 'ok', statusMessage: null }
	}
	if (!connected) {
		return { status: 'needs_attention', statusMessage: 'Not connected yet.' }
	}
	return {
		status: 'needs_attention',
		statusMessage: `Reconnect needed${input.authFailedReason ? ` (${input.authFailedReason})` : ''}.`,
	}
}
