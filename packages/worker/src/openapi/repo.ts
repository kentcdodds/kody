import { type OpenApiBinding } from './binding-shared.ts'

export type UserOpenApiBindingRow = {
	user_id: string
	name: string
	spec_url: string
	api_base_url: string
	description: string | null
	auth_json: string
	selection_json: string
	include_destructive: number
	spec_title: string | null
	spec_version: string | null
	created_at: string
	updated_at: string
}

export type UserOpenApiBindingOperationRow = {
	user_id: string
	binding_name: string
	slug: string
	operation_json: string
}

export type OpenApiBindingWithOperations = {
	binding: UserOpenApiBindingRow
	operations: Array<UserOpenApiBindingOperationRow>
}

const bindingSelectColumns = `
	user_id, name, spec_url, api_base_url, description, auth_json,
	selection_json, include_destructive, spec_title, spec_version,
	created_at, updated_at
`

export async function listOpenApiBindingsForUser(input: {
	db: D1Database
	userId: string
}): Promise<Array<OpenApiBindingWithOperations>> {
	const bindingsResult = await input.db
		.prepare(
			`SELECT ${bindingSelectColumns}
			FROM user_openapi_bindings
			WHERE user_id = ?
			ORDER BY name ASC`,
		)
		.bind(input.userId)
		.all<UserOpenApiBindingRow>()
	const bindings = bindingsResult.results ?? []
	if (bindings.length === 0) return []

	const operationsResult = await input.db
		.prepare(
			`SELECT user_id, binding_name, slug, operation_json
			FROM user_openapi_binding_operations
			WHERE user_id = ?
			ORDER BY binding_name ASC, slug ASC`,
		)
		.bind(input.userId)
		.all<UserOpenApiBindingOperationRow>()
	const operationsByName = new Map<
		string,
		Array<UserOpenApiBindingOperationRow>
	>()
	for (const operation of operationsResult.results ?? []) {
		const existing = operationsByName.get(operation.binding_name)
		if (existing) {
			existing.push(operation)
		} else {
			operationsByName.set(operation.binding_name, [operation])
		}
	}

	return bindings.map((binding) => ({
		binding,
		operations: operationsByName.get(binding.name) ?? [],
	}))
}

export async function getOpenApiBindingByName(input: {
	db: D1Database
	userId: string
	name: string
}): Promise<OpenApiBindingWithOperations | null> {
	const binding = await input.db
		.prepare(
			`SELECT ${bindingSelectColumns}
			FROM user_openapi_bindings
			WHERE user_id = ? AND name = ?
			LIMIT 1`,
		)
		.bind(input.userId, input.name)
		.first<UserOpenApiBindingRow>()
	if (!binding) return null

	const operationsResult = await input.db
		.prepare(
			`SELECT user_id, binding_name, slug, operation_json
			FROM user_openapi_binding_operations
			WHERE user_id = ? AND binding_name = ?
			ORDER BY slug ASC`,
		)
		.bind(input.userId, input.name)
		.all<UserOpenApiBindingOperationRow>()

	return {
		binding,
		operations: operationsResult.results ?? [],
	}
}

export async function upsertOpenApiBinding(input: {
	db: D1Database
	userId: string
	binding: OpenApiBinding
	createdAt?: string
}): Promise<void> {
	const now = new Date().toISOString()
	const createdAt = input.createdAt ?? now
	const updatedAt = input.binding.updatedAt || now

	const statements: Array<D1PreparedStatement> = [
		input.db
			.prepare(
				`INSERT INTO user_openapi_bindings (
					user_id, name, spec_url, api_base_url, description, auth_json,
					selection_json, include_destructive, spec_title, spec_version,
					created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(user_id, name)
				DO UPDATE SET
					spec_url = excluded.spec_url,
					api_base_url = excluded.api_base_url,
					description = excluded.description,
					auth_json = excluded.auth_json,
					selection_json = excluded.selection_json,
					include_destructive = excluded.include_destructive,
					spec_title = excluded.spec_title,
					spec_version = excluded.spec_version,
					updated_at = excluded.updated_at`,
			)
			.bind(
				input.userId,
				input.binding.name,
				input.binding.specUrl,
				input.binding.apiBaseUrl,
				input.binding.description ?? null,
				JSON.stringify(input.binding.auth),
				JSON.stringify(input.binding.selection),
				input.binding.includeDestructive ? 1 : 0,
				input.binding.specTitle ?? null,
				input.binding.specVersion ?? null,
				createdAt,
				updatedAt,
			),
		input.db
			.prepare(
				`DELETE FROM user_openapi_binding_operations
				WHERE user_id = ? AND binding_name = ?`,
			)
			.bind(input.userId, input.binding.name),
	]

	for (const operation of input.binding.operations) {
		statements.push(
			input.db
				.prepare(
					`INSERT INTO user_openapi_binding_operations (
						user_id, binding_name, slug, operation_json
					) VALUES (?, ?, ?, ?)`,
				)
				.bind(
					input.userId,
					input.binding.name,
					operation.slug,
					JSON.stringify(operation),
				),
		)
	}

	await input.db.batch(statements)
}

export async function deleteOpenApiBindingByName(input: {
	db: D1Database
	userId: string
	name: string
}): Promise<boolean> {
	const result = await input.db.batch([
		input.db
			.prepare(
				`DELETE FROM user_openapi_binding_operations
				WHERE user_id = ? AND binding_name = ?`,
			)
			.bind(input.userId, input.name),
		input.db
			.prepare(
				`DELETE FROM user_openapi_bindings
				WHERE user_id = ? AND name = ?`,
			)
			.bind(input.userId, input.name),
	])
	const bindingDelete = result[1]
	return (bindingDelete?.meta.changes ?? 0) > 0
}
