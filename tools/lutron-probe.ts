import { config as loadDotenv } from 'dotenv'
import { Socket } from 'node:net'
import { resolve } from 'node:path'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { randomUUID } from 'node:crypto'

type ProbeResult = {
	host: string
	port: number
	ok: boolean
	summary: string
	details?: string
}

type LeapResponse = {
	CommuniqueType?: string
	Header?: {
		StatusCode?: string
		Url?: string
		ClientTag?: string
		MessageBodyType?: string
	}
	Body?: unknown
}

const DEFAULT_HOSTS = ['192.168.0.40', '192.168.0.41', '192.168.0.130']
const DEFAULT_PORTS = [23, 8081, 8902]
const DEFAULT_TIMEOUT_MS = 3_000

loadDotenv({ path: resolve(process.cwd(), '.env') })

const username = process.env['LUTRON_USERNAME']?.trim() ?? ''
const password = process.env['LUTRON_PASSWORD']?.trim() ?? ''
const args = new Set(process.argv.slice(2))
const timeoutMs = Number(
	process.env['LUTRON_PROBE_TIMEOUT_MS'] ?? DEFAULT_TIMEOUT_MS,
)

function shouldTryLogin() {
	return username.length > 0 && password.length > 0 && !args.has('--skip-login')
}

function getHosts() {
	const cliHosts = process.argv
		.slice(2)
		.filter((arg) => !arg.startsWith('--'))
		.flatMap((arg) => arg.split(','))
		.map((arg) => arg.trim())
		.filter(Boolean)

	return cliHosts.length > 0 ? cliHosts : DEFAULT_HOSTS
}

function formatValue(value: unknown) {
	if (value == null) return ''
	if (typeof value === 'string') return value
	return JSON.stringify(value, null, 2)
}

function wait(ms: number) {
	return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

function readFromSocket(socket: Socket, delayMs = 500) {
	return new Promise<string>((resolveRead) => {
		const chunks: Array<Buffer> = []

		const onData = (chunk: Buffer) => {
			chunks.push(chunk)
		}

		const finish = () => {
			socket.off('data', onData)
			resolveRead(Buffer.concat(chunks).toString('utf8'))
		}

		socket.on('data', onData)
		setTimeout(finish, delayMs)
	})
}

function connectTcp(host: string, port: number) {
	return new Promise<Socket>((resolveConnect, rejectConnect) => {
		const socket = new Socket()
		socket.setTimeout(timeoutMs)

		socket.once('error', (error) => {
			socket.destroy()
			rejectConnect(error)
		})

		socket.once('timeout', () => {
			socket.destroy()
			rejectConnect(new Error('TCP connection timed out'))
		})

		socket.connect(port, host, () => {
			socket.removeAllListeners('error')
			socket.removeAllListeners('timeout')
			resolveConnect(socket)
		})
	})
}

function connectTls(host: string, port: number) {
	return new Promise<TLSSocket>((resolveConnect, rejectConnect) => {
		const socket = tlsConnect({
			host,
			port,
			rejectUnauthorized: false,
			servername: host,
			timeout: timeoutMs,
		})

		socket.once('secureConnect', () => {
			socket.removeAllListeners('error')
			socket.removeAllListeners('timeout')
			resolveConnect(socket)
		})

		socket.once('error', (error) => {
			socket.destroy()
			rejectConnect(error)
		})

		socket.once('timeout', () => {
			socket.destroy()
			rejectConnect(new Error('TLS connection timed out'))
		})
	})
}

async function probeTcpPort(host: string, port: number): Promise<ProbeResult> {
	try {
		const socket = await connectTcp(host, port)
		socket.end()
		return {
			host,
			port,
			ok: true,
			summary: 'TCP port is open',
		}
	} catch (error) {
		return {
			host,
			port,
			ok: false,
			summary: 'TCP port is not reachable',
			details: formatValue(error instanceof Error ? error.message : error),
		}
	}
}

async function probeTelnet(host: string) {
	const result: Array<ProbeResult> = []

	try {
		const socket = await connectTcp(host, 23)
		const greeting = await readFromSocket(socket)
		result.push({
			host,
			port: 23,
			ok: true,
			summary: greeting.trim() || 'Connected without greeting',
		})

		if (shouldTryLogin()) {
			socket.write(`${username}\r\n`)
			const passwordPrompt = await readFromSocket(socket)

			socket.write(`${password}\r\n`)
			const loginResult = await readFromSocket(socket, 1_000)

			result.push({
				host,
				port: 23,
				ok: !/invalid login/i.test(loginResult),
				summary: 'Telnet login attempt completed',
				details: [
					passwordPrompt.trim()
						? `After username: ${passwordPrompt.trim()}`
						: '',
					loginResult.trim() ? `After password: ${loginResult.trim()}` : '',
				]
					.filter(Boolean)
					.join('\n'),
			})
		}

		socket.end()
	} catch (error) {
		result.push({
			host,
			port: 23,
			ok: false,
			summary: 'Telnet connection failed',
			details: formatValue(error instanceof Error ? error.message : error),
		})
	}

	return result
}

async function readTlsLine(socket: TLSSocket, delayMs = 1_000) {
	return new Promise<string>((resolveRead) => {
		const chunks: Array<Buffer> = []

		const onData = (chunk: Buffer) => {
			chunks.push(chunk)
			if (chunk.includes(0x0a)) {
				finish()
			}
		}

		const finish = () => {
			socket.off('data', onData)
			clearTimeout(timer)
			resolveRead(Buffer.concat(chunks).toString('utf8').trim())
		}

		const timer = setTimeout(finish, delayMs)
		socket.on('data', onData)
	})
}

async function probeLeapPort(host: string, port: number) {
	const results: Array<ProbeResult> = []

	try {
		const socket = await connectTls(host, port)
		results.push({
			host,
			port,
			ok: true,
			summary: `TLS connected (${socket.getProtocol() ?? 'unknown protocol'})`,
		})

		const pingMessage = {
			CommuniqueType: 'ReadRequest',
			Header: {
				ClientTag: randomUUID(),
				Url: '/server/status/ping',
			},
		}
		socket.write(`${JSON.stringify(pingMessage)}\n`)
		const pingRaw = await readTlsLine(socket)
		let pingSummary = pingRaw || 'No response to LEAP ping'
		try {
			const parsed = JSON.parse(pingRaw) as LeapResponse
			pingSummary =
				`${parsed.CommuniqueType ?? 'Unknown'} ${parsed.Header?.StatusCode ?? ''}`.trim()
		} catch {
			// Keep raw summary when response is not JSON.
		}
		results.push({
			host,
			port,
			ok: pingRaw.length > 0,
			summary: 'LEAP ping completed',
			details: pingSummary,
		})

		if (port === 8081 && shouldTryLogin()) {
			const loginMessage = {
				CommuniqueType: 'UpdateRequest',
				Header: {
					ClientTag: randomUUID(),
					Url: '/login',
				},
				Body: {
					Login: {
						ContextType: 'Application',
						LoginId: username,
						Password: password,
					},
				},
			}
			socket.write(`${JSON.stringify(loginMessage)}\n`)
			const loginRaw = await readTlsLine(socket)
			let loginDetails = loginRaw || 'No response to LEAP login'
			let loginOk = false
			try {
				const parsed = JSON.parse(loginRaw) as LeapResponse
				loginOk = parsed.Header?.StatusCode?.startsWith('200') ?? false
				loginDetails = JSON.stringify(parsed, null, 2)
			} catch {
				// Keep raw response.
			}
			results.push({
				host,
				port,
				ok: loginOk,
				summary: 'LEAP login attempt completed',
				details: loginDetails,
			})
		}

		socket.end()
		await wait(50)
	} catch (error) {
		results.push({
			host,
			port,
			ok: false,
			summary: 'TLS/LEAP probe failed',
			details: formatValue(error instanceof Error ? error.message : error),
		})
	}

	return results
}

async function main() {
	const hosts = getHosts()

	console.log('Lutron probe starting...')
	console.log(`Hosts: ${hosts.join(', ')}`)
	console.log(`Using .env at ${resolve(process.cwd(), '.env')}`)
	console.log(`Credentials loaded: ${shouldTryLogin() ? 'yes' : 'no'}`)
	console.log('')

	for (const host of hosts) {
		console.log(`## ${host}`)

		for (const port of DEFAULT_PORTS) {
			const tcpResult = await probeTcpPort(host, port)
			console.log(
				`[${tcpResult.ok ? 'ok' : 'fail'}] ${host}:${port} ${tcpResult.summary}`,
			)
			if (tcpResult.details) {
				console.log(tcpResult.details)
			}

			if (port === 23 && tcpResult.ok) {
				for (const result of await probeTelnet(host)) {
					console.log(
						`[${result.ok ? 'ok' : 'fail'}] ${host}:${result.port} ${result.summary}`,
					)
					if (result.details) {
						console.log(result.details)
					}
				}
			}

			if ((port === 8081 || port === 8902) && tcpResult.ok) {
				for (const result of await probeLeapPort(host, port)) {
					console.log(
						`[${result.ok ? 'ok' : 'fail'}] ${host}:${result.port} ${result.summary}`,
					)
					if (result.details) {
						console.log(result.details)
					}
				}
			}
		}

		console.log('')
	}
}

await main()
