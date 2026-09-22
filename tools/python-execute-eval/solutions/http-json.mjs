import { kody } from 'kody:runtime'

export default async function main(params) {
	const response = await kody.call('http.get', { url: params.url })
	return { status: response.status, value: response.json.value }
}
