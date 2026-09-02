export const fleetPackageErrorRateConcentrationKinds = [
	'one_account',
	'few_accounts',
	'fleet',
] as const

export type FleetPackageErrorRateConcentrationKind =
	(typeof fleetPackageErrorRateConcentrationKinds)[number]

/** Share of recent-window errors that counts as concentrated. */
export const fleetPackageErrorRateConcentrationShare = 0.8

/** How many leading accounts can still count as "a few" rather than fleet-wide. */
export const fleetPackageErrorRateFewAccountLimit = 3

export const fleetPackageErrorRateMaxNamedOwners = 3
export const fleetPackageErrorRateMaxNamedPackages = 5

export type FleetPackageErrorRateConcentrationPackage = {
	kody_id: string
}

export type FleetPackageErrorRateConcentrationOwner = {
	username: string
	error_share: number
	packages: Array<FleetPackageErrorRateConcentrationPackage>
}

/**
 * Operator-facing concentration of a fleet error-rate elevation.
 * Names usernames and package kody ids only — no emails, user ids, or
 * package UUIDs.
 */
export type FleetPackageErrorRateConcentration = {
	kind: FleetPackageErrorRateConcentrationKind
	recent_errors: number
	owner_count: number
	package_count: number
	top_owner_share: number
	owners: Array<FleetPackageErrorRateConcentrationOwner>
}

export function isFleetPackageErrorRateConcentrationKind(
	value: string,
): value is FleetPackageErrorRateConcentrationKind {
	return (
		fleetPackageErrorRateConcentrationKinds as ReadonlyArray<string>
	).includes(value)
}

export function classifyFleetPackageErrorRateConcentrationKind(input: {
	topOwnerShare: number
	topFewShare: number
}): FleetPackageErrorRateConcentrationKind {
	if (input.topOwnerShare >= fleetPackageErrorRateConcentrationShare) {
		return 'one_account'
	}
	if (input.topFewShare >= fleetPackageErrorRateConcentrationShare) {
		return 'few_accounts'
	}
	return 'fleet'
}

export function formatFleetPackageErrorRateConcentration(
	concentration: FleetPackageErrorRateConcentration,
): string {
	const topPercent = formatSharePercent(concentration.top_owner_share)
	switch (concentration.kind) {
		case 'one_account': {
			const owner = formatOwnerList(concentration.owners)
			return owner.length > 0
				? `One account owns ${topPercent} of recent errors (${owner}).`
				: `One account owns ${topPercent} of recent errors.`
		}
		case 'few_accounts': {
			const owners = formatOwnerList(concentration.owners)
			return owners.length > 0
				? `A few accounts own most recent errors (top owner ${topPercent}: ${owners}).`
				: `A few accounts own most recent errors (top owner ${topPercent}).`
		}
		case 'fleet':
			return `Errors are spread across the fleet (top owner ${topPercent}).`
		default: {
			const exhaustive: never = concentration.kind
			throw new Error(
				`Unhandled fleet package error-rate concentration kind: ${exhaustive}`,
			)
		}
	}
}

function formatSharePercent(share: number) {
	return `${Math.round(share * 100)}%`
}

function formatOwnerList(
	owners: ReadonlyArray<FleetPackageErrorRateConcentrationOwner>,
) {
	return owners
		.map((owner) => {
			const packages = owner.packages.map((pkg) => pkg.kody_id).join(', ')
			return packages.length > 0
				? `${owner.username}: ${packages}`
				: owner.username
		})
		.join('; ')
}
