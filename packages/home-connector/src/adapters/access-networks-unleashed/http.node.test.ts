import { createServer } from 'node:https'
import { afterEach, expect, test, vi } from 'vitest'
import { fetchAccessNetworksUnleashed } from './http.ts'

const selfSignedKey = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDbsmDeJNKCZ95U
7GSBr6U6M/v5k33wFK56MebRkW3VYDQ4vGQQSN6CcYxCe7UPH/HINhHyLVWGU3d8
K2vy8NaLEGryhjRBUBojpkHfFfHXAlg5+nOCm00WR6p37VSBetwrvVmf4sauetZw
S6KD6NWseR1XB2+AFZQP/KCh9zwCzmdSvtKjpCl3Lk8PcaQ9d84+/4iVRySRNIw0
6LsmiYf1/F2VwA8JkTWEh9tZzVDddazU+bZ8Dgf+AAs6D7xzgWFYqSUKxKJQh3Wp
eXkuyQeSENpA/Gi4JmiIOMQufXe/IdzHYbWv0W/E53+kSHp0oGt1eyW7Sm0oztMd
IEuFkkLdAgMBAAECggEAXdmJf9wDASoV0/lXxf6eeoqSbT8QYWq0TgbbL1MMtEXw
iPwRUtOOGfMfk5b89YUT6A8RA39SNZuaQzTZXGJ9g9JznT6vO+dYAzqWkRHyyYJ6
5emTRovJFmdu7uQ3YUh2nUi57I8XiJl42We1+NuRy6fBXNgUTYbqRRoKFKZkwF1Y
nglQRgIniA8C9A9uSKyCvmi/0HSpxWHmIkxg8JZGLf7fPkqPXfp5SAm2V4YThSV1
thh3ZNPN+HdkXdIthjDufHgzV6ULu0EpCysLmZYKgFNEN1jHIFk0+DWJPNyL5+DT
ft2w2/zk3JJagliqk0BunZ+4v7HgmGYfRMha37VdEQKBgQD/nVNjeMTaGmN7buhW
409sQtW+yrpXlZuFudEkNFDhpn/NkeNydXU/xpTejtwrWOzJCQtEa/G0oYkhIJH6
j2dOnYhdNKvAs2PWwva3BQk2KObwXS7izv6ZbK5Qw3XzVZhk0+d5QBFWQHKzpv6Q
e3uurpDdwrhPOYOSvd1hkbkZ5wKBgQDcBy/531G+iQbbpVe4J7Fnezwz2jytb12q
c8D7q2EmuoltHD3tTF2V0KYnnNoAlRhRPO7xqsOaBlnBV5M73uwNtQghMcqTjna4
WtLfYc5pSsCawCsG6ATBq8a3SE1DC79swu3uOGTVSd4cA0IdXTnvTqE3QsLC3+gr
GDJGTtlMmwKBgGJFrgWULLpdYtnVreWZxrMsjtinQDTkA8LJyapNorreNExoRjV/
CvDV++4EpojTy1UO8RIBHg//+qSNzRGziFglIIQU9+NCFKRAmHGMshnsZ70JVjlE
s4VwzyOlwfcndUtuXJO1GfU7Gd4P2dbaYpap7nATqKBs0DTeYfpc9/kJAoGAKQou
KK0+0gs8/Dsa4X6F2Idj80gBiVf8YI62sDqHJHImr/NUma5kxkzksP7QqsskfgKf
jvQLB++nTijHjaNG5Eef/JEM9/jarAhEzOWxWnJW+oZdgCxGttkTd5xEzPyj9+Vj
+8sJA7+DbjYtXszEwZ4o8+W/7hlVdLROrE6IuYECgYAU4Chz7nvP132SmyXLKgVv
9GPH+xI/UgzvmxBjtgqcPQ/Roi6+loGqYJJGvXEimf2REdGyEK7SX4Un3AH8VkVm
tbrpcez7d/dXJ/l++C1qseTqEKSfX8Rk8OVDqR59QWTp1nPC5Z1nWYXBaO8Kwmy5
Bs37iUBVhgKZTxCkO6cFXQ==
-----END PRIVATE KEY-----`

const selfSignedCert = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUL/al+VrfYXdjNcW3ytqoFpFNMkwwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDUwNDAwNDIxOVoXDTM2MDUw
MTAwNDIxOVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA27Jg3iTSgmfeVOxkga+lOjP7+ZN98BSuejHm0ZFt1WA0
OLxkEEjegnGMQnu1Dx/xyDYR8i1VhlN3fCtr8vDWixBq8oY0QVAaI6ZB3xXx1wJY
OfpzgptNFkeqd+1UgXrcK71Zn+LGrnrWcEuig+jVrHkdVwdvgBWUD/ygofc8As5n
Ur7So6Qpdy5PD3GkPXfOPv+IlUckkTSMNOi7JomH9fxdlcAPCZE1hIfbWc1Q3XWs
1Pm2fA4H/gALOg+8c4FhWKklCsSiUId1qXl5LskHkhDaQPxouCZoiDjELn13vyHc
x2G1r9FvxOd/pEh6dKBrdXslu0ptKM7THSBLhZJC3QIDAQABo28wbTAdBgNVHQ4E
FgQUwY5a4jlDUoniVMX1x9q2tkema2kwHwYDVR0jBBgwFoAUwY5a4jlDUoniVMX1
x9q2tkema2kwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAAEyoChJC+HFA+LkdGy3eQabUw/WanJ8
BIXO0OWOBe4VMg1GSUqjB9niIBEWpZ4mQ/x1vwnWIt6kn1pLERqRKwrV4yW582TO
Rv/FbdR+VL4ykQFCknGrH1zG3K755YoGLlD2lJBrScM9D+xOZ/0WfqFTx2MTs6s3
JZLuuU4XjHDSTIc6DKKU+YTwk+ANL8MfONCIZSDyUe3MMw9H6FRZTzvDLuXxMfww
jKbkC67T7aqOpngjGU9ZGCCBfj1EDW9VRT1xqLkKNo2O0t/Bu4o/JMq/AA0/ZtcB
Bv7qWcDYLo2w2FjEIz2TvoyhcG0zMiOcrSyPrZ1s8TM57Q6gwe7IfZU=
-----END CERTIFICATE-----`

const originalFetch = globalThis.fetch

afterEach(() => {
	globalThis.fetch = originalFetch
})

async function withSelfSignedServer<T>(
	handler: Parameters<typeof createServer>[1],
	run: (url: string) => Promise<T>,
) {
	const server = createServer(
		{
			key: selfSignedKey,
			cert: selfSignedCert,
		},
		handler,
	)
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve)
	})
	const address = server.address()
	if (!address || typeof address === 'string') {
		throw new Error('Expected HTTPS test server to listen on a TCP port.')
	}
	try {
		return await run(`https://127.0.0.1:${address.port}`)
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error) reject(error)
				else resolve()
			})
		})
	}
}

test('built-in fetch rejects self-signed TLS unless explicitly allowed', async () => {
	await withSelfSignedServer(
		(_request, response) => {
			response.end('unleashed')
		},
		async (url) => {
			await expect(
				fetchAccessNetworksUnleashed({
					url,
					timeoutMs: 1_000,
					allowInsecureTls: false,
				}),
			).rejects.toThrow('fetch failed')

			const response = await fetchAccessNetworksUnleashed({
				url,
				timeoutMs: 1_000,
				allowInsecureTls: true,
			})

			expect(response.status).toBe(200)
			await expect(response.text()).resolves.toBe('unleashed')
		},
	)
})

test('mocked fetch remains mockable when insecure TLS is enabled', async () => {
	const fetchMock = vi.fn(async () => new Response('mocked'))
	globalThis.fetch = fetchMock as typeof fetch

	const response = await fetchAccessNetworksUnleashed({
		url: 'https://unleashed.local',
		timeoutMs: 1_000,
		allowInsecureTls: true,
	})

	expect(fetchMock).toHaveBeenCalledOnce()
	await expect(response.text()).resolves.toBe('mocked')
})
