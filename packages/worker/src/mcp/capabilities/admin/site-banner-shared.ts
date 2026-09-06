import { z } from 'zod'
import { planNameSchema, stableUserIdSchema } from './admin-shared.ts'
import {
	siteBannerAudiences,
	siteBannerIcons,
	siteBannerLooks,
	siteBannerPageTargetings,
	siteBannerSeverities,
} from '#universal/site-banners.ts'

export const siteBannerIdSchema = z
	.string()
	.uuid()
	.describe('Site banner UUID.')

export const siteBannerRecordSchema = z.object({
	id: siteBannerIdSchema,
	enabled: z.boolean(),
	priority: z.number().int().min(0).max(1000),
	title: z.string(),
	body: z.string(),
	ctaHref: z.string().nullable(),
	ctaLabel: z.string().nullable(),
	secondaryHref: z.string().nullable(),
	secondaryLabel: z.string().nullable(),
	severity: z.enum(siteBannerSeverities),
	look: z.enum(siteBannerLooks),
	icon: z.enum(siteBannerIcons).nullable(),
	imageUrl: z.string().nullable(),
	pageTargeting: z.enum(siteBannerPageTargetings),
	routePatterns: z.array(z.string()),
	audience: z.enum(siteBannerAudiences),
	audienceUserIds: z.array(stableUserIdSchema),
	audiencePlans: z.array(planNameSchema),
	dismissible: z.boolean(),
	startsAt: z.string().nullable(),
	endsAt: z.string().nullable(),
	createdBy: z.number().int().nullable(),
	updatedBy: z.number().int().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
})

export const siteBannerSaveInputSchema = z.object({
	id: siteBannerIdSchema
		.optional()
		.describe('Existing banner UUID. Omit to create a new banner.'),
	enabled: z.boolean().describe('Whether the banner is eligible to show.'),
	priority: z
		.number()
		.int()
		.min(0)
		.max(1000)
		.describe('Higher priority wins when more than one banner matches.'),
	title: z.string().min(1).max(120),
	body: z.string().max(400).optional().default(''),
	ctaHref: z.string().nullable().optional(),
	ctaLabel: z.string().nullable().optional(),
	secondaryHref: z.string().nullable().optional(),
	secondaryLabel: z.string().nullable().optional(),
	severity: z.enum(siteBannerSeverities),
	look: z
		.enum(siteBannerLooks)
		.describe('Visual treatment: strip, promo, or card.'),
	icon: z.enum(siteBannerIcons).nullable().optional(),
	imageUrl: z.string().nullable().optional(),
	pageTargeting: z.enum(siteBannerPageTargetings),
	routePatterns: z
		.array(z.string())
		.optional()
		.describe(
			'Glob patterns such as /blog/* or /account/**. Used when pageTargeting is routes.',
		),
	audience: z.enum(siteBannerAudiences),
	audienceUserIds: z.array(stableUserIdSchema).optional(),
	audiencePlans: z.array(planNameSchema).optional(),
	dismissible: z
		.boolean()
		.describe('When true, viewers can dismiss the banner forever.'),
	startsAt: z.string().nullable().optional(),
	endsAt: z.string().nullable().optional(),
})
