# session

Source: https://github.com/remix-run/remix/tree/main/packages/session

## Overview

A full-featured session management library for JavaScript. This package provides
a flexible and secure way to manage user sessions in server-side applications
with a flexible API for different session storage strategies.

## Features

- **Multiple Storage Strategies:** Includes memory, cookie, and file-based
  storage strategies for different use cases
- **Flash Messages:** Support for flash data that persists only for the next
  request
- **Session Security:** Built-in protection against session fixation attacks

## Installation

```sh
npm install @remix-run/session
```

## Usage

The standard pattern is to read the session from the request, modify it, and
save it back to storage and write the session cookie to the response.

```ts
import { createCookieSessionStorage } from '@remix-run/session/cookie-storage'

// Create a session storage. This is used to store session data across requests.
let storage = createCookieSessionStorage()

// This function simulates a typical request flow where the session is read from
// the request cookie, modified, and the new cookie is returned in the response.
async function handleRequest(cookie: string | null) {
	let session = await storage.read(cookie)
	session.set('count', Number(session.get('count') ?? 0) + 1)
	return {
		session, // The session data from this "request"
		cookie: await storage.save(session), // The cookie to use on the next request
	}
}

let response1 = await handleRequest(null)
assert.equal(response1.session.get('count'), 1)

let response2 = await handleRequest(response1.cookie)
assert.equal(response2.session.get('count'), 2)

let response3 = await handleRequest(response2.cookie)
assert.equal(response3.session.get('count'), 3)
```

The example above is a low-level illustration of how to use this package for
session management. In practice, you would use the `session` middleware in
[`fetch-router`](https://github.com/remix-run/remix/tree/main/packages/fetch-router)
to automatically manage the session for you.

## Navigation

- [Flash data and security](./flash-and-security.md)
- [Storage strategies](./storage-strategies.md)
- [Related packages](./related.md)
- [Remix package index](../index.md)
