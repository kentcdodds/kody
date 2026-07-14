import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { expect, test } from 'vitest'

const routeSchema = z.enum([
	'existing-capability-or-package',
	'execute-prototype',
	'package-authoring',
])
const reasonCodeSchema = z.enum([
	'exact-match',
	'no-match',
	'one-off',
	'unproven',
	'recurring',
	'scheduled',
	'durable-reuse',
	'cross-host',
	'successful-prototype',
])
const themeSchema = z.enum([
	'recurring-email-drafting',
	'reusable-writing-style',
	'scheduled-workflow',
	'cross-host-reuse',
	'promote-successful-script',
])

const evalSetSchema = z
	.object({
		schemaVersion: z.literal(1),
		name: z.literal('package-discovery-routing'),
		instruction: z.string().min(1),
		routes: z.array(routeSchema).length(routeSchema.options.length),
		reasonCodes: z
			.array(reasonCodeSchema)
			.length(reasonCodeSchema.options.length),
		cases: z
			.array(
				z
					.object({
						id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
						theme: themeSchema,
						discovery: z.discriminatedUnion('status', [
							z
								.object({
									status: z.literal('exact-match'),
									kind: z.enum(['capability', 'package']),
									summary: z.string().min(1),
								})
								.strict(),
							z
								.object({
									status: z.literal('no-match'),
									kind: z.literal('none'),
									summary: z.string().min(1),
								})
								.strict(),
						]),
						prompt: z.string().min(1),
						expected: z
							.object({
								route: routeSchema,
								requiredReasonCodes: z.array(reasonCodeSchema).min(1),
							})
							.strict(),
					})
					.strict(),
			)
			.min(1),
	})
	.strict()

test('package discovery routing eval has a valid schema and complete routing coverage', () => {
	const rawEvalSet: unknown = JSON.parse(
		readFileSync(
			new URL('./package-discovery-routing.json', import.meta.url),
			'utf8',
		),
	)
	const evalSet = evalSetSchema.parse(rawEvalSet)

	expect(new Set(evalSet.routes)).toEqual(new Set(routeSchema.options))
	expect(new Set(evalSet.reasonCodes)).toEqual(
		new Set(reasonCodeSchema.options),
	)
	expect(new Set(evalSet.cases.map(({ id }) => id)).size).toBe(
		evalSet.cases.length,
	)
	expect(new Set(evalSet.cases.map(({ theme }) => theme))).toEqual(
		new Set(themeSchema.options),
	)
	expect(new Set(evalSet.cases.map(({ expected }) => expected.route))).toEqual(
		new Set(routeSchema.options),
	)

	for (const evalCase of evalSet.cases) {
		expect(new Set(evalCase.expected.requiredReasonCodes).size).toBe(
			evalCase.expected.requiredReasonCodes.length,
		)
		if (evalCase.discovery.status === 'exact-match') {
			expect(evalCase.expected.route).toBe('existing-capability-or-package')
			expect(evalCase.expected.requiredReasonCodes).toContain('exact-match')
		} else {
			expect(evalCase.expected.requiredReasonCodes).toContain('no-match')
		}
	}
})
