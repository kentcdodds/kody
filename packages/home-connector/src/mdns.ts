import bonjour from 'bonjour'

export type MdnsResolvedService = {
	instanceName: string
	host: string | null
	port: number | null
	address: string | null
	txtLine: string
	raw: string
}

type BonjourTxt = string | Buffer | number | boolean | Array<string | Buffer>

function normalizeTxtValue(value: BonjourTxt) {
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value)
	}
	if (value instanceof Buffer) return value.toString('utf8')
	if (Array.isArray(value)) {
		return value
			.map((entry) =>
				typeof entry === 'string'
					? entry
					: entry instanceof Buffer
						? entry.toString('utf8')
						: String(entry),
			)
			.join(',')
	}
	return String(value)
}

export async function discoverMdnsServices(input: {
	serviceType: string
	timeoutMs?: number
}) {
	const timeoutMs = input.timeoutMs ?? 4_000
	const serviceName = input.serviceType
		.replace(/^_/, '')
		.replace(/\._(tcp|udp)$/, '')
	const protocol = input.serviceType.includes('._udp') ? 'udp' : 'tcp'
	const browser = bonjour()

	return await new Promise<Array<MdnsResolvedService>>((resolve, reject) => {
		const services = new Map<string, MdnsResolvedService>()
		let settled = false

		function finish() {
			if (settled) return
			settled = true
			clearTimeout(timer)
			try {
				browser.destroy()
			} catch {
				// Ignore cleanup failures.
			}
			resolve(
				[...services.values()].sort((left, right) =>
					left.instanceName.localeCompare(right.instanceName),
				),
			)
		}

		const timer = setTimeout(finish, timeoutMs)
		try {
			const finder = browser.find(
				{
					type: serviceName,
					protocol,
				},
				(service) => {
					const key =
						service.fqdn ||
						`${service.name}.${service.type}.${service.protocol}`
					const txtLine = Object.entries(service.txt ?? {})
						.map(
							([txtKey, txtValue]) =>
								`${txtKey}=${normalizeTxtValue(txtValue as BonjourTxt)}`,
						)
						.join(' ')
					const host = service.host?.replace(/\.$/, '') ?? null
					const address =
						Array.isArray(service.addresses) && service.addresses.length > 0
							? (service.addresses.find((entry) =>
									/^\d+\.\d+\.\d+\.\d+$/.test(entry),
								) ??
								service.addresses[0] ??
								null)
							: null

					services.set(key, {
						instanceName: service.name,
						host,
						port: typeof service.port === 'number' ? service.port : null,
						address,
						txtLine,
						raw: JSON.stringify(
							{
								name: service.name,
								fqdn: service.fqdn,
								host: service.host,
								port: service.port,
								addresses: service.addresses,
								txt: service.txt,
								type: service.type,
								protocol: service.protocol,
							},
							null,
							2,
						),
					})
				},
			)
			finder.start()
		} catch (error) {
			clearTimeout(timer)
			try {
				browser.destroy()
			} catch {
				// Ignore cleanup failures.
			}
			reject(error)
		}
	})
}
