import { z } from 'zod'
import { defineCapability } from '../define-capability.ts'
import { type CapabilityContext } from '../types.ts'

type OperationFn = (left: number, right: number) => number
type MathOperator = '+' | '-' | '*' | '/'

const operations = {
	'+': (left: number, right: number) => left + right,
	'-': (left: number, right: number) => left - right,
	'*': (left: number, right: number) => left * right,
	'/': (left: number, right: number) => left / right,
} satisfies Record<MathOperator, OperationFn>

const mathOperators = Object.keys(operations) as Array<MathOperator>

const doMathArgsSchema = z.object({
	left: z.number().describe('Left operand (finite number). Example: 8'),
	right: z.number().describe('Right operand (finite number). Example: 4'),
	operator: z
		.enum(mathOperators)
		.describe('Operator. Valid values: "+", "-", "*", "/".'),
	precision: z
		.number()
		.int()
		.min(0)
		.max(15)
		.default(6)
		.describe(
			'Decimal places used only for the formatted string output (0-15, default: 6). Does not change the computed numeric result.',
		),
})

const doMathOutputSchema = z.object({
	left: z.number(),
	operator: z.enum(mathOperators),
	right: z.number(),
	expression: z.string().describe('Expression string, for example: "8 + 4".'),
	result: z.number().describe('Exact numeric result.'),
	formattedResult: z
		.string()
		.describe('Display-friendly result string using the requested precision.'),
	precisionUsed: z.number().int().min(0).max(15),
})

function formatNumberForMarkdown(value: number, precision: number) {
	if (Number.isInteger(value)) return String(value)
	const rounded = value.toFixed(precision)
	return rounded.includes('.') ? rounded.replace(/\.?0+$/, '') : rounded
}

export const doMathCapability = defineCapability({
	name: 'do_math',
	domain: 'math',
	description:
		'Compute a single arithmetic operation over two numbers. Division by zero is rejected.',
	tags: ['arithmetic', 'calculation'],
	keywords: ['add', 'subtract', 'multiply', 'divide', 'precision'],
	readOnly: true,
	idempotent: true,
	inputSchema: doMathArgsSchema.describe(
		'Inputs for a single arithmetic operation. Use precision to control formatted display output only.',
	),
	outputSchema: doMathOutputSchema,
	async handler(args, _ctx: CapabilityContext) {
		const { left, right, operator, precision } = args

		if (operator === '/' && right === 0) {
			throw new Error(
				'Division by zero. Next: Choose a non-zero right operand.',
			)
		}

		const operation = operations[operator]
		const result = operation(left, right)
		if (!Number.isFinite(result)) {
			throw new Error(
				'Result is not a finite number. Next: Use smaller inputs or choose a different operator.',
			)
		}

		return {
			left,
			operator,
			right,
			expression: `${left} ${operator} ${right}`,
			result,
			formattedResult: formatNumberForMarkdown(result, precision),
			precisionUsed: precision,
		}
	},
})
