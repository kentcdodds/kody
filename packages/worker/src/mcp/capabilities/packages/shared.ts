import { z } from 'zod'
import {
	type SavedPackageRecord,
	type SavedPackageWithCommunityProvenanceRecord,
} from '#worker/package-registry/types.ts'

export const packageFileSchema = z.object({
	path: z
		.string()
		.min(1)
		.describe(
			'Package-relative file path to write into the saved package repo.',
		),
	content: z
		.string()
		.describe(
			'Full file contents for this package file. For README.md, maintain a concise Intent section when creating or materially changing a package.',
		),
})

export const packageSummarySchema = z.object({
	package_id: z.string(),
	kody_id: z.string(),
	name: z.string(),
	description: z.string(),
	tags: z.array(z.string()),
	has_app: z.boolean(),
	hidden: z.boolean(),
	source_id: z.string(),
	created_at: z.string(),
	updated_at: z.string(),
})

export const packageSummaryWithCommunityProvenanceSchema =
	packageSummarySchema.extend({
		source_listing_id: z
			.string()
			.nullable()
			.describe(
				'Community listing id this package was forked from, or null for a self-authored package.',
			),
		listing_current: z
			.boolean()
			.nullable()
			.describe(
				'Whether the source community listing id currently resolves to an active listing, or null for a self-authored package.',
			),
		listing_kody_id: z
			.string()
			.nullable()
			.describe(
				'Original community listing kody.id recorded when this package was forked, or null for a self-authored package.',
			),
	})

export const pendingPackageSecretApprovalsSchema = z
	.object({
		package_id: z.string().describe('Saved package id that needs approvals.'),
		kody_id: z.string().describe('Package kody.id that needs approvals.'),
		secrets: z
			.array(
				z.object({
					secret_name: z.string(),
					approval_url: z
						.string()
						.describe('Per-secret package approval URL in the account UI.'),
				}),
			)
			.describe('User secrets that still need package approval.'),
		bulk_approval_url: z
			.string()
			.nullable()
			.describe(
				'One-click bulk approval URL when two or more secrets still need package approval; prefer this over individual links.',
			),
	})
	.nullable()
	.describe(
		'Pending user-secret package approvals detected from secretMounts and secret placeholders. Null when none are pending. Do not treat the package as ready to run until the user approves these and a keyless packages.invoke smoke test succeeds against a read-only export or dry-run input that actually uses the approved secret (invoke runs in the package runtime, so secret mounts resolve).',
	)

export function toPackageSummary(savedPackage: SavedPackageRecord) {
	return {
		package_id: savedPackage.id,
		kody_id: savedPackage.kodyId,
		name: savedPackage.name,
		description: savedPackage.description,
		tags: savedPackage.tags,
		has_app: savedPackage.hasApp,
		hidden: savedPackage.hidden,
		source_id: savedPackage.sourceId,
		created_at: savedPackage.createdAt,
		updated_at: savedPackage.updatedAt,
	}
}

export function toPackageSummaryWithCommunityProvenance(
	savedPackage: SavedPackageWithCommunityProvenanceRecord,
) {
	return {
		...toPackageSummary(savedPackage),
		source_listing_id: savedPackage.sourceListingId,
		listing_current: savedPackage.listingCurrent,
		listing_kody_id: savedPackage.listingKodyId,
	}
}

export const packageExportSurfaceSchema = z.object({
	subpath: z
		.string()
		.describe('Package export subpath from package.json exports.'),
	import_specifier: z
		.string()
		.describe('Ready-to-use kody: import specifier for this export.'),
	runtime_target: z
		.string()
		.nullable()
		.describe('Package-relative runtime source path for this export.'),
	types_path: z
		.string()
		.nullable()
		.describe(
			'Package-relative types source path for this export, when declared.',
		),
	description: z
		.string()
		.nullable()
		.describe('Export description parsed from JSDoc when available.'),
	type_definition: z
		.string()
		.nullable()
		.describe(
			'Primary export type signature parsed from source when available.',
		),
	external_invocation: z
		.object({
			method: z.literal('POST'),
			url: z
				.string()
				.describe(
					'Canonical owner-scoped external invocation URL for this package export.',
				),
			path: z
				.string()
				.describe(
					'Canonical owner-scoped external invocation path for this package export.',
				),
			owner_username: z.string(),
			kody_id: z.string(),
			route_export_name: z
				.string()
				.describe(
					'Export name segment used in the URL path; leading ./ is omitted and the root export uses __root__.',
				),
			normalized_export_name: z
				.string()
				.describe('Export name after Kody normalization for scope checks.'),
			token_setup_url: z
				.string()
				.describe(
					'Token setup URL prefilled for this package and export. This is not an invocation URL.',
				),
			source_guidance: z.string(),
		})
		.nullable()
		.describe(
			'HTTP invocation metadata for external trusted callers using package invocation tokens, or null when no public owner username is available.',
		),
})

export const packageDetailSchema =
	packageSummaryWithCommunityProvenanceSchema.extend({
		exports: z.array(packageExportSurfaceSchema),
	})

export const packageInvocationTokenMetadataSchema = z.object({
	token_id: z
		.string()
		.describe(
			'Package invocation token record id. This is not a bearer token.',
		),
	name: z.string().describe('Human-readable token record name.'),
	package_ids: z
		.array(z.string())
		.describe(
			'Saved package ids allowed by this token record, including * when wildcard-scoped.',
		),
	package_kody_ids: z
		.array(z.string())
		.describe(
			'Saved package kody.id scopes allowed by this token record, including * when wildcard-scoped.',
		),
	export_names: z
		.array(z.string())
		.describe(
			'Normalized package export scopes allowed by this token record, including * when wildcard-scoped.',
		),
	allowed_sources: z
		.array(z.string())
		.describe('Optional exact source labels allowed by this token record.'),
	created_at: z.string(),
	updated_at: z.string(),
	last_used_at: z
		.string()
		.nullable()
		.describe('Most recent successful bearer-token use, when tracked.'),
	revoked_at: z
		.string()
		.nullable()
		.describe('Revocation timestamp, or null when the token record is active.'),
})
