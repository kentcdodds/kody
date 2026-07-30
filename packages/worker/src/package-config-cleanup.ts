export async function deleteAllPackageScopedSecrets(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	packageId: string
}) {
	const result = await input.env.APP_DB.prepare(
		`DELETE FROM secret_buckets
		WHERE user_id = ? AND scope = 'package' AND binding_key = ?`,
	)
		.bind(input.userId, input.packageId)
		.run()
	return result.meta.changes ?? 0
}

export async function removeAllSecretApprovalsForPackage(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	packageId: string
}) {
	const result = await input.env.APP_DB.prepare(
		`UPDATE secret_entries AS e
		SET allowed_packages = (
			SELECT json_group_array(value)
			FROM json_each(e.allowed_packages)
			WHERE value <> ?
		),
		updated_at = CURRENT_TIMESTAMP
		WHERE e.bucket_id IN (
			SELECT id
			FROM secret_buckets
			WHERE user_id = ? AND scope = 'user'
		)
		AND json_valid(e.allowed_packages)
		AND EXISTS (
			SELECT 1
			FROM json_each(e.allowed_packages)
			WHERE value = ?
		)`,
	)
		.bind(input.packageId, input.userId, input.packageId)
		.run()
	return result.meta.changes ?? 0
}

export async function deleteAllAppScopedValues(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	appId: string
}) {
	const result = await input.env.APP_DB.prepare(
		`DELETE FROM value_buckets
		WHERE user_id = ? AND scope = ? AND binding_key = ?`,
	)
		.bind(input.userId, 'app', input.appId)
		.run()
	return (result.meta.changes ?? 0) > 0
}
