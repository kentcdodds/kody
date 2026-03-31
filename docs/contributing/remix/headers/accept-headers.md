# Accept headers

Source: https://github.com/remix-run/remix/tree/main/packages/headers

Each supported header has a class that represents the header value. Use the
static `from()` method to parse header values. Each class has a `toString()`
method that returns the header value as a string.

## Accept

Parse, manipulate and stringify
[`Accept` headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Accept).

Implements `Map<mediaType, quality>`.

```ts
import { Accept } from '@remix-run/headers'

// Parse from headers
let accept = Accept.from(request.headers.get('accept'))

accept.mediaTypes // ['text/html', 'text/*']
accept.weights // [1, 0.9]
accept.accepts('text/html') // true
accept.accepts('text/plain') // true (matches text/*)
accept.accepts('image/jpeg') // false
accept.getWeight('text/plain') // 1 (matches text/*)
accept.getPreferred(['text/html', 'text/plain']) // 'text/html'

// Iterate
for (let [mediaType, quality] of accept) {
	// ...
}

// Modify and set header
accept.set('application/json', 0.8)
accept.delete('text/*')
headers.set('Accept', accept)

// Construct directly
new Accept('text/html, text/*;q=0.9')
new Accept({ 'text/html': 1, 'text/*': 0.9 })
new Accept(['text/html', ['text/*', 0.9]])

// Use class for type safety when setting Headers values
// via Accept's `.toString()` method
let headers = new Headers({
	Accept: new Accept({ 'text/html': 1, 'application/json': 0.8 }),
})
headers.set('Accept', new Accept({ 'text/html': 1, 'application/json': 0.8 }))
```

## Accept-Encoding

Parse, manipulate and stringify
[`Accept-Encoding` headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Accept-Encoding).

Implements `Map<encoding, quality>`.

```ts
import { AcceptEncoding } from '@remix-run/headers'

// Parse from headers
let acceptEncoding = AcceptEncoding.from(request.headers.get('accept-encoding'))

acceptEncoding.encodings // ['gzip', 'deflate']
acceptEncoding.weights // [1, 0.8]
acceptEncoding.accepts('gzip') // true
acceptEncoding.accepts('br') // false
acceptEncoding.getWeight('gzip') // 1
acceptEncoding.getPreferred(['gzip', 'deflate', 'br']) // 'gzip'

// Modify and set header
acceptEncoding.set('br', 1)
acceptEncoding.delete('deflate')
headers.set('Accept-Encoding', acceptEncoding)

// Construct directly
new AcceptEncoding('gzip, deflate;q=0.8')
new AcceptEncoding({ gzip: 1, deflate: 0.8 })

// Use class for type safety when setting Headers values
// via AcceptEncoding's `.toString()` method
let headers = new Headers({
	'Accept-Encoding': new AcceptEncoding({ gzip: 1, br: 0.9 }),
})
headers.set('Accept-Encoding', new AcceptEncoding({ gzip: 1, br: 0.9 }))
```

## Accept-Language

Parse, manipulate and stringify
[`Accept-Language` headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Accept-Language).

Implements `Map<language, quality>`.

```ts
import { AcceptLanguage } from '@remix-run/headers'

// Parse from headers
let acceptLanguage = AcceptLanguage.from(request.headers.get('accept-language'))

acceptLanguage.languages // ['en-us', 'en']
acceptLanguage.weights // [1, 0.9]
acceptLanguage.accepts('en-US') // true
acceptLanguage.accepts('en-GB') // true (matches en)
acceptLanguage.getWeight('en-GB') // 1 (matches en)
acceptLanguage.getPreferred(['en-US', 'en-GB', 'fr']) // 'en-US'

// Modify and set header
acceptLanguage.set('fr', 0.5)
acceptLanguage.delete('en')
headers.set('Accept-Language', acceptLanguage)

// Construct directly
new AcceptLanguage('en-US, en;q=0.9')
new AcceptLanguage({ 'en-US': 1, en: 0.9 })

// Use class for type safety when setting Headers values
// via AcceptLanguage's `.toString()` method
let headers = new Headers({
	'Accept-Language': new AcceptLanguage({ 'en-US': 1, fr: 0.5 }),
})
headers.set('Accept-Language', new AcceptLanguage({ 'en-US': 1, fr: 0.5 }))
```

## Navigation

- [Headers overview](./index.md)
- [Content and cache headers](./content-headers.md)
- [Remix package index](../index.md)
