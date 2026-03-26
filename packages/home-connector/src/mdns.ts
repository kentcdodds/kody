import { spawn } from 'node:child_process'

export type MdnsResolvedService = {
	instanceName: string
	host: string | null
	port: number | null
	address: string | null
	txtLine: string
	raw: string
}

function decodeMdnsEscapes(value: string) {
	return value
		.replaceAll(/\\([0-7]{3})/g, (_match, octal: string) =>
			String.fromCharCode(Number.parseInt(octal, 8)),
		)
		.replaceAll(/\\(.)/g, '$1')
}

function stripQuotes(value: string) {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1)
	}
	return value
}

async function runCommand(
	command: string,
	args: Array<string>,
	timeoutMs: number,
) {
	return await new Promise<string>((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		let stdout = ''
		let stderr = ''
		const timer = setTimeout(() => {
			child.kill('SIGINT')
		}, timeoutMs)
		child.stdout.on('data', (chunk) => {
			stdout += String(chunk)
		})
		child.stderr.on('data', (chunk) => {
			stderr += String(chunk)
		})
		child.on('error', (error) => {
			clearTimeout(timer)
			reject(error)
		})
		child.on('close', () => {
			clearTimeout(timer)
			resolve([stdout, stderr.trim()].filter(Boolean).join('\n'))
		})
	})
}

function isCommandMissing(error: unknown) {
	return (
		error instanceof Error &&
		'code' in error &&
		(error as NodeJS.ErrnoException).code === 'ENOENT'
	)
}

function parseDnsSdBrowseOutput(output: string, serviceType: string) {
	const services = new Set<string>()
	for (const line of output.split('\n')) {
		if (!line.includes(`${serviceType}.`)) continue
		const match = line.match(new RegExp(`${serviceType.replace('.', '\\.')}\\.\\s+(.*)$`))
		if (match?.[1]) {
			services.add(match[1].trim())
		}
	}
	return [...services]
}

async function discoverWithDnsSd(input: {
	serviceType: string
	timeoutMs: number
}): Promise<Array<MdnsResolvedService>> {
	const browseOutput = await runCommand(
		'dns-sd',
		['-B', input.serviceType, 'local.'],
		input.timeoutMs,
	)
	const serviceNames = parseDnsSdBrowseOutput(browseOutput, input.serviceType)
	const resolved: Array<MdnsResolvedService> = []

	for (const serviceName of serviceNames) {
		const lookupOutput = await runCommand(
			'dns-sd',
			['-L', serviceName, input.serviceType, 'local.'],
			input.timeoutMs,
		)
		let host: string | null = null
		let port: number | null = null
		const txtParts: Array<string> = []

		for (const line of lookupOutput.split('\n')) {
			if (line.includes('can be reached at')) {
				const match = line.match(/can be reached at\s+(\S+):(\d+)/)
				if (match) {
					host = match[1]?.replace(/\.$/, '') ?? null
					port = Number.parseInt(match[2] ?? '', 10)
				}
				continue
			}
			if (line.includes('=')) {
				txtParts.push(line.trim())
			}
		}

		resolved.push({
			instanceName: serviceName,
			host,
			port,
			address: null,
			txtLine: txtParts.join(' '),
			raw: lookupOutput,
		})
	}

	return resolved
}

function parseAvahiTxtParts(parts: Array<string>) {
	return parts
		.map((part) => decodeMdnsEscapes(stripQuotes(part.trim())))
		.filter(Boolean)
}

async function discoverWithAvahi(input: {
	serviceType: string
	timeoutMs: number
}): Promise<Array<MdnsResolvedService>> {
	const output = await runCommand(
		'avahi-browse',
		['-rtp', input.serviceType],
		input.timeoutMs,
	)
	const resolved: Array<MdnsResolvedService> = []

	for (const line of output.split('\n')) {
		if (!line.startsWith('=')) continue
		const parts = line.split(';')
		if (parts.length < 9) continue
		const instanceName = decodeMdnsEscapes(parts[3] ?? '')
		const host = (parts[6] ?? '').replace(/\.$/, '') || null
		const address = (parts[7] ?? '').trim() || null
		const portValue = Number.parseInt(parts[8] ?? '', 10)
		const txtParts = parseAvahiTxtParts(parts.slice(9))

		resolved.push({
			instanceName,
			host,
			port: Number.isFinite(portValue) ? portValue : null,
			address,
			txtLine: txtParts.join(' '),
			raw: line,
		})
	}

	return resolved
}

export async function discoverMdnsServices(input: {
	serviceType: string
	timeoutMs?: number
}) {
	const timeoutMs = input.timeoutMs ?? 4_000
	try {
		return await discoverWithDnsSd({
			serviceType: input.serviceType,
			timeoutMs,
		})
	} catch (error) {
		if (!isCommandMissing(error)) {
			throw error
		}
	}

	return await discoverWithAvahi({
		serviceType: input.serviceType,
		timeoutMs,
	})
}
