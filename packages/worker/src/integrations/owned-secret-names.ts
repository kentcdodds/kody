/**
 * Secret-store names that exist only because an OAuth integration or user-lane
 * app referenced them. Used to hide those rows from standalone secret lists
 * during the dual-write soak.
 */
export async function listReferencedIntegrationSecretNames(input: {
	db: D1Database
	userId: string
}): Promise<Set<string>> {
	const [connectionResult, appResult] = await Promise.all([
		input.db
			.prepare(
				`SELECT access_token_secret_name, refresh_token_secret_name
				FROM user_integrations
				WHERE user_id = ?`,
			)
			.bind(input.userId)
			.all<{
				access_token_secret_name: string
				refresh_token_secret_name: string | null
			}>(),
		input.db
			.prepare(
				`SELECT client_secret_secret_name
				FROM user_oauth_apps
				WHERE user_id = ? AND client_secret_secret_name IS NOT NULL`,
			)
			.bind(input.userId)
			.all<{ client_secret_secret_name: string | null }>(),
	])
	const names = new Set<string>()
	for (const row of connectionResult.results ?? []) {
		const access = row.access_token_secret_name.trim()
		if (access) names.add(access)
		const refresh = row.refresh_token_secret_name?.trim()
		if (refresh) names.add(refresh)
	}
	for (const row of appResult.results ?? []) {
		const clientSecret = row.client_secret_secret_name?.trim()
		if (clientSecret) names.add(clientSecret)
	}
	return names
}

export async function findIntegrationOwningSecretName(input: {
	db: D1Database
	userId: string
	secretName: string
}): Promise<{ name: string } | null> {
	const name = input.secretName.trim()
	if (!name) return null
	const connection = await input.db
		.prepare(
			`SELECT name
			FROM user_integrations
			WHERE user_id = ?
				AND (
					access_token_secret_name = ?
					OR refresh_token_secret_name = ?
				)
			LIMIT 1`,
		)
		.bind(input.userId, name, name)
		.first<{ name: string }>()
	if (connection) return { name: connection.name }
	const app = await input.db
		.prepare(
			`SELECT i.name AS name
			FROM user_oauth_apps a
			JOIN user_integrations i
				ON i.user_id = a.user_id AND i.app_slug = a.slug
			WHERE a.user_id = ? AND a.client_secret_secret_name = ?
			LIMIT 1`,
		)
		.bind(input.userId, name)
		.first<{ name: string }>()
	return app ? { name: app.name } : null
}
