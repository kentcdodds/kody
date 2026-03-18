# Cookie headers

Source: https://github.com/remix-run/remix/tree/main/packages/headers

## Cookie

Parse, manipulate and stringify
[`Cookie` headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cookie).

Implements `Map<name, value>`.

```ts
import { Cookie } from '@remix-run/headers'

// Parse from headers
let cookie = Cookie.from(request.headers.get('cookie'))

cookie.get('session_id') // 'abc123'
cookie.get('theme') // 'dark'
cookie.has('session_id') // true
cookie.size // 2

// Iterate
for (let [name, value] of cookie) {
	// ...
}

// Modify and set header
cookie.set('theme', 'light')
cookie.delete('session_id')
headers.set('Cookie', cookie)

// Construct directly
new Cookie('session_id=abc123; theme=dark')
new Cookie({ session_id: 'abc123', theme: 'dark' })
new Cookie([
	['session_id', 'abc123'],
	['theme', 'dark'],
])

// Use class for type safety when setting Headers values
// via Cookie's `.toString()` method
let headers = new Headers({
	Cookie: new Cookie({ session_id: 'abc123', theme: 'dark' }),
})
headers.set('Cookie', new Cookie({ session_id: 'abc123', theme: 'dark' }))
```

## Set-Cookie

Parse, manipulate and stringify
[`Set-Cookie` headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie).

```ts
import { SetCookie } from '@remix-run/headers'

// Parse from headers
let setCookie = SetCookie.from(response.headers.get('set-cookie'))

setCookie.name // "session_id"
setCookie.value // "abc"
setCookie.path // "/"
setCookie.httpOnly // true
setCookie.secure // true
setCookie.domain // undefined
setCookie.maxAge // undefined
setCookie.expires // undefined
setCookie.sameSite // undefined

// Modify and set header
setCookie.maxAge = 3600
setCookie.sameSite = 'Strict'
headers.set('Set-Cookie', setCookie)

// Construct directly
new SetCookie('session_id=abc; Path=/; HttpOnly; Secure')
new SetCookie({
	name: 'session_id',
	value: 'abc',
	path: '/',
	httpOnly: true,
	secure: true,
})

// Use class for type safety when setting Headers values
// via SetCookie's `.toString()` method
let headers = new Headers({
	'Set-Cookie': new SetCookie({
		name: 'session_id',
		value: 'abc',
		httpOnly: true,
	}),
})
headers.set(
	'Set-Cookie',
	new SetCookie({ name: 'session_id', value: 'abc', httpOnly: true }),
)
```

## Navigation

- [Headers overview](./index.md)
- [Conditionals and ranges](./conditional-headers.md)
- [Remix package index](../index.md)
