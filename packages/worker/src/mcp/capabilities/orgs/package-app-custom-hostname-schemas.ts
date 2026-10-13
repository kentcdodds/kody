import { z } from 'zod'
import { packageAppCustomHostnameBindingKinds } from '#worker/package-app-custom-hostnames/types.ts'

export const packageAppCustomHostnameDnsRecordSchema = z.object({
	type: z.string(),
	name: z.string(),
	value: z.string(),
})

export const packageAppCustomHostnameRowSchema = z.object({
	id: z.string(),
	hostname: z.string(),
	binding_kind: z.enum(packageAppCustomHostnameBindingKinds),
	package_id: z.string().nullable(),
	org_id: z.string().nullable(),
	hostname_status: z.string(),
	ssl_status: z.string(),
	verified_at: z.string().nullable(),
	dns_missing_since: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
})

export const packageAppCustomHostnameDnsHintSchema = z.object({
	type: z.literal('CNAME'),
	name: z.string(),
	target: z.string().nullable(),
})

export const packageAppCustomHostnameVerificationSchema = z.object({
	ownership_verification: packageAppCustomHostnameDnsRecordSchema.nullable(),
	ssl_validation_records: z.array(packageAppCustomHostnameDnsRecordSchema),
})
