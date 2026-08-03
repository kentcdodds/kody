import { commitSystemEmailAuthorityBatch } from './system-email-authority.ts'

export type SystemInboundEventMutation = {
	eventId: string
	dedicated: D1PreparedStatement
}

export async function commitSystemInboundEventMutations(input: {
	db: D1Database
	mutations: ReadonlyArray<SystemInboundEventMutation>
	before?: ReadonlyArray<D1PreparedStatement>
	after?: ReadonlyArray<D1PreparedStatement>
}) {
	const beforeCount = input.before?.length ?? 0
	const results = await commitSystemEmailAuthorityBatch({
		db: input.db,
		statements: [
			...(input.before ?? []),
			...input.mutations.map((mutation) => mutation.dedicated),
			...(input.after ?? []),
		],
	})
	return {
		results,
		mutationResults: input.mutations.map((_mutation, index) => ({
			dedicated: results[beforeCount + index],
		})),
	}
}

export async function commitSystemInboundEventMutation(input: {
	db: D1Database
	eventId: string
	dedicated: D1PreparedStatement
	before?: ReadonlyArray<D1PreparedStatement>
	after?: ReadonlyArray<D1PreparedStatement>
}) {
	const { results, mutationResults } = await commitSystemInboundEventMutations({
		db: input.db,
		before: input.before,
		mutations: [
			{
				eventId: input.eventId,
				dedicated: input.dedicated,
			},
		],
		after: input.after,
	})
	return {
		results,
		dedicatedResult: mutationResults[0]?.dedicated,
	}
}
