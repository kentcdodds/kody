import { type StorageContext } from '#mcp/storage.ts'
import { getValue, listValues } from '#mcp/values/service.ts'
import {
	buildOpenApiBindingValueName,
	parseOpenApiBinding,
	parseOpenApiBindingJson,
	parseOpenApiBindingValueName,
	type OpenApiBinding,
} from '#worker/openapi/binding-shared.ts'

export async function listOpenApiBindings(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	storageContext?: StorageContext | null
}): Promise<Array<OpenApiBinding>> {
	const values = await listValues({
		env: input.env,
		userId: input.userId,
		scope: 'user',
		storageContext: {
			sessionId: input.storageContext?.sessionId ?? null,
			appId: input.storageContext?.appId ?? null,
			storageId: input.storageContext?.storageId ?? null,
		},
	})
	const bindings: Array<OpenApiBinding> = []
	for (const value of values) {
		const bindingName = parseOpenApiBindingValueName(value.name)
		if (!bindingName) continue
		const parsed = parseOpenApiBinding(
			parseOpenApiBindingJson(value.value),
			bindingName,
		)
		if (parsed) bindings.push(parsed)
	}
	bindings.sort((left, right) => left.name.localeCompare(right.name, 'en'))
	return bindings
}

export async function getOpenApiBinding(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	name: string
	storageContext?: StorageContext | null
}): Promise<OpenApiBinding | null> {
	const value = await getValue({
		env: input.env,
		userId: input.userId,
		name: buildOpenApiBindingValueName(input.name),
		scope: 'user',
		storageContext: {
			sessionId: input.storageContext?.sessionId ?? null,
			appId: input.storageContext?.appId ?? null,
			storageId: input.storageContext?.storageId ?? null,
		},
	})
	if (!value) return null
	return parseOpenApiBinding(parseOpenApiBindingJson(value.value), input.name)
}
