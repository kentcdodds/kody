import {
	array,
	object,
	optional,
	string,
	type InferOutput,
	union,
} from 'remix/data-schema'
import { minLength } from 'remix/data-schema/checks'

const nonEmptyStringSchema = string().pipe(minLength(1))

const outboundEmailSchema = object({
	from: nonEmptyStringSchema,
	to: union([nonEmptyStringSchema, array(nonEmptyStringSchema)]),
	subject: nonEmptyStringSchema,
	html: nonEmptyStringSchema,
	text: optional(nonEmptyStringSchema),
})

export type OutboundEmail = InferOutput<typeof outboundEmailSchema>

export { outboundEmailSchema }
