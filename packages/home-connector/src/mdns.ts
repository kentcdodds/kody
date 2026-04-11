import dnsEqual from 'dns-equal'
import dnsTxt from 'dns-txt'
import multicastDns from 'multicast-dns'
import mdnsServiceTypes from 'multicast-dns-service-types'

export type MdnsResolvedService = {
	instanceName: string
	host: string | null
	port: number | null
	address: string | null
	txtLine: string
	raw: string
}

type BonjourTxt = string | Buffer | number | boolean | Array<string | Buffer>

type StoredRecord = {
	type: string
	name: string
	data: unknown
	ttl: number
}

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

function stripTrailingDot(name: string) {
	return name.endsWith('.') ? name.slice(0, -1) : name
}

function recordKey(type: string, name: string) {
	return `${type}:${name.toLowerCase()}`
}

function ingestPacket(
	records: Map<string, StoredRecord>,
	packet: { answers?: unknown[]; additionals?: unknown[] },
) {
	const sections = [...(packet.answers ?? []), ...(packet.additionals ?? [])]
	for (const rr of sections) {
		if (!rr || typeof rr !== 'object') continue
		const r = rr as {
			type?: string
			name?: string
			data?: unknown
			ttl?: number
		}
		if (!r.type || !r.name) continue
		if ((r.ttl ?? 0) === 0) continue
		records.set(recordKey(r.type, r.name), {
			type: r.type,
			name: r.name,
			data: r.data,
			ttl: r.ttl ?? 255,
		})
	}
}

function findRecord(
	records: Map<string, StoredRecord>,
	type: string,
	name: string,
): StoredRecord | undefined {
	for (const r of records.values()) {
		if (r.type === type && dnsEqual(r.name, name)) return r
	}
	return undefined
}

function ptrInstanceNames(
	records: Map<string, StoredRecord>,
	ptrDomain: string,
): Array<string> {
	const names: Array<string> = []
	for (const r of records.values()) {
		if (
			r.type === 'PTR' &&
			dnsEqual(r.name, ptrDomain) &&
			typeof r.data === 'string'
		) {
			names.push(r.data)
		}
	}
	return [...new Set(names)]
}

function decodeTxtRecord(
	txtData: unknown,
	codec: ReturnType<typeof dnsTxt>,
): Record<string, string> {
	let buf: Buffer
	if (Array.isArray(txtData)) {
		buf = Buffer.concat(
			txtData.map((chunk) =>
				Buffer.isBuffer(chunk)
					? chunk
					: Buffer.from(chunk as string | Uint8Array),
			),
		)
	} else if (Buffer.isBuffer(txtData)) {
		buf = txtData
	} else if (typeof txtData === 'string') {
		buf = Buffer.from(txtData)
	} else {
		return {}
	}
	const decoded = codec.decode(buf) as Record<string, string | boolean>
	const out: Record<string, string> = {}
	for (const [k, v] of Object.entries(decoded)) {
		out[k] = normalizeTxtValue(v as BonjourTxt)
	}
	return out
}

function buildResolvedServices(
	records: Map<string, StoredRecord>,
	ptrDomain: string,
	txtCodec: ReturnType<typeof dnsTxt>,
): Array<MdnsResolvedService> {
	const services = new Map<string, MdnsResolvedService>()
	for (const fqdn of ptrInstanceNames(records, ptrDomain)) {
		const srv = findRecord(records, 'SRV', fqdn)
		if (!srv || typeof srv.data !== 'object' || !srv.data) continue
		const srvData = srv.data as { target?: string; port?: number }
		const target = stripTrailingDot(String(srvData.target ?? ''))
		if (!target || typeof srvData.port !== 'number') continue

		const txtRec = findRecord(records, 'TXT', fqdn)
		const txtObj = txtRec
			? decodeTxtRecord(txtRec.data, txtCodec)
			: ({} as Record<string, string>)
		const txtLine = Object.entries(txtObj)
			.map(([txtKey, txtValue]) => `${txtKey}=${txtValue}`)
			.join(' ')

		const a =
			findRecord(records, 'A', target) ?? findRecord(records, 'A', `${target}.`)
		const address =
			a && typeof a.data === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(a.data)
				? a.data
				: null

		const instanceName = stripTrailingDot(fqdn).split('.')[0] ?? fqdn

		services.set(fqdn, {
			instanceName,
			host: target || null,
			port: srvData.port,
			address,
			txtLine,
			raw: JSON.stringify(
				{
					name: instanceName,
					fqdn,
					host: `${target}.`,
					port: srvData.port,
					addresses: address ? [address] : [],
					txt: txtObj,
					type: stripTrailingDot(fqdn).split('.')[1]?.replace(/^_/, '') ?? null,
					protocol: 'tcp',
				},
				null,
				2,
			),
		})
	}
	return [...services.values()].sort((left, right) =>
		left.instanceName.localeCompare(right.instanceName),
	)
}

function ptrQueryName(serviceType: string) {
	const serviceName = serviceType.replace(/^_/, '').replace(/\._(tcp|udp)$/, '')
	const protocol = serviceType.includes('._udp') ? 'udp' : 'tcp'
	return `${mdnsServiceTypes.stringify(serviceName, protocol)}.local`
}

export async function discoverMdnsServices(input: {
	serviceType: string
	timeoutMs?: number
}) {
	const timeoutMs = input.timeoutMs ?? 4_000
	const ptrDomain = ptrQueryName(input.serviceType)
	const txtCodec = dnsTxt()
	const records = new Map<string, StoredRecord>()
	const client = multicastDns({ loopback: false })

	function issueFollowUpQueries() {
		client.query(ptrDomain, 'PTR')
		for (const fqdn of ptrInstanceNames(records, ptrDomain)) {
			client.query(fqdn, 'SRV')
			client.query(fqdn, 'TXT')
			const srv = findRecord(records, 'SRV', fqdn)
			if (srv && typeof srv.data === 'object' && srv.data) {
				const target = stripTrailingDot(
					String((srv.data as { target?: string }).target ?? ''),
				)
				if (target) {
					client.query(target, 'A')
				}
			}
		}
	}

	await new Promise<void>((resolve, reject) => {
		let settled = false
		let poll: ReturnType<typeof setInterval> | undefined
		let timer: ReturnType<typeof setTimeout> | undefined

		const onResponse = (packet: {
			answers?: unknown[]
			additionals?: unknown[]
		}) => {
			ingestPacket(records, packet)
		}
		const onError = (error: Error) => {
			if (settled) return
			settled = true
			if (poll) clearInterval(poll)
			if (timer) clearTimeout(timer)
			client.removeListener('response', onResponse)
			client.removeListener('error', onError)
			try {
				client.destroy()
			} catch {
				// Ignore cleanup failures.
			}
			reject(error)
		}
		const finishOk = () => {
			if (settled) return
			settled = true
			if (poll) clearInterval(poll)
			if (timer) clearTimeout(timer)
			client.removeListener('response', onResponse)
			client.removeListener('error', onError)
			try {
				client.destroy()
			} catch {
				// Ignore cleanup failures.
			}
			resolve()
		}

		client.on('response', onResponse)
		client.on('error', onError)

		issueFollowUpQueries()
		poll = setInterval(issueFollowUpQueries, 750)
		timer = setTimeout(finishOk, timeoutMs)
	})

	return buildResolvedServices(records, ptrDomain, txtCodec)
}
