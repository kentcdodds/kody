import {
	array,
	object,
	string,
	union,
	type InferOutput,
} from 'remix/data-schema'
import { minLength } from 'remix/data-schema/checks'

const nonEmptyStringSchema = string().pipe(minLength(1))

const resendEmailSchema = object({
	from: nonEmptyStringSchema,
	to: union([nonEmptyStringSchema, array(nonEmptyStringSchema)]),
	subject: nonEmptyStringSchema,
	html: nonEmptyStringSchema,
})

export type ResendEmail = InferOutput<typeof resendEmailSchema>

export { resendEmailSchema }
