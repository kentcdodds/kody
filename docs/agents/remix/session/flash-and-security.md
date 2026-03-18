# Flash data and security

Source: https://github.com/remix-run/remix/tree/main/packages/session

## Flash messages

Flash messages are values that persist only for the next request, perfect for
displaying one-time notifications:

```ts
async function requestIndex(cookie: string | null) {
	let session = await storage.read(cookie)
	return { session, cookie: await storage.save(session) }
}

async function requestSubmit(cookie: string | null) {
	let session = await storage.read(cookie)
	session.flash('message', 'success!')
	return { session, cookie: await storage.save(session) }
}

// Flash data is undefined on the first request
let response1 = await requestIndex(null)
assert.equal(response1.session.get('message'), undefined)

// Flash data is undefined on the same request it is set. This response
// is typically a redirect to a route that displays the flash data.
let response2 = await requestSubmit(response1.cookie)
assert.equal(response2.session.get('message'), undefined)

// Flash data is available on the next request
let response3 = await requestIndex(response2.cookie)
assert.equal(response3.session.get('message'), 'success!')

// Flash data is not available on subsequent requests
let response4 = await requestIndex(response3.cookie)
assert.equal(response4.session.get('message'), undefined)
```

## Regenerating session IDs

For security, regenerate the session ID after privilege changes like a login.
This helps prevent session fixation attacks by issuing a new session ID in the
response.

```ts
import { createFsSessionStorage } from '@remix-run/session/fs-storage'

let sessionStorage = createFsSessionStorage('/tmp/sessions')

async function requestIndex(cookie: string | null) {
	let session = await sessionStorage.read(cookie)
	return { session, cookie: await sessionStorage.save(session) }
}

async function requestLogin(cookie: string | null) {
	let session = await sessionStorage.read(cookie)
	session.set('userId', 'mj')
	session.regenerateId()
	return { session, cookie: await sessionStorage.save(session) }
}

let response1 = await requestIndex(null)
assert.equal(response1.session.get('userId'), undefined)

let response2 = await requestLogin(response1.cookie)
assert.notEqual(response2.session.id, response1.session.id)

let response3 = await requestIndex(response2.cookie)
assert.equal(response3.session.get('userId'), 'mj')
```

To delete the old session data when the session is saved, use
`session.regenerateId(true)`. This can help to prevent session fixation attacks
by deleting the old session data when the session is saved. However, it may not
be desirable in a situation with mobile clients on flaky connections that may
need to resume the session using an old session ID.

## Destroying sessions

When a user logs out, you should destroy the session using `session.destroy()`.

This will clear all session data from storage the next time it is saved. It also
clears the session ID on the client in the next response, so it will start with
a new session on the next request.

## Navigation

- [Session overview](./index.md)
- [Storage strategies](./storage-strategies.md)
- [Remix package index](../index.md)
