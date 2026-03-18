# Content and cache headers

Source: https://github.com/remix-run/remix/tree/main/packages/headers

## Cache-Control

Parse, manipulate and stringify
[`Cache-Control` headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control).

```ts
import { CacheControl } from '@remix-run/headers'

// Parse from headers
let cacheControl = CacheControl.from(response.headers.get('cache-control'))

cacheControl.public // true
cacheControl.maxAge // 3600
cacheControl.sMaxage // 7200
cacheControl.noCache // undefined
cacheControl.noStore // undefined
cacheControl.noTransform // undefined
cacheControl.mustRevalidate // undefined
cacheControl.immutable // undefined

// Modify and set header
cacheControl.maxAge = 7200
cacheControl.immutable = true
headers.set('Cache-Control', cacheControl)

// Construct directly
new CacheControl('public, max-age=3600')
new CacheControl({ public: true, maxAge: 3600 })

// Use class for type safety when setting Headers values
// via CacheControl's `.toString()` method
let headers = new Headers({
	'Cache-Control': new CacheControl({ public: true, maxAge: 3600 }),
})
headers.set('Cache-Control', new CacheControl({ public: true, maxAge: 3600 }))
```

## Content-Disposition

Parse, manipulate and stringify
[`Content-Disposition` headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Disposition).

```ts
import { ContentDisposition } from '@remix-run/headers'

// Parse from headers
let contentDisposition = ContentDisposition.from(
	response.headers.get('content-disposition'),
)

contentDisposition.type // 'attachment'
contentDisposition.filename // 'example.pdf'
contentDisposition.filenameSplat // "UTF-8''example.pdf"
contentDisposition.preferredFilename // 'example.pdf' (decoded from filename*)

// Modify and set header
contentDisposition.filename = 'download.pdf'
headers.set('Content-Disposition', contentDisposition)

// Construct directly
new ContentDisposition('attachment; filename="example.pdf"')
new ContentDisposition({ type: 'attachment', filename: 'example.pdf' })

// Use class for type safety when setting Headers values
// via ContentDisposition's `.toString()` method
let headers = new Headers({
	'Content-Disposition': new ContentDisposition({
		type: 'attachment',
		filename: 'example.pdf',
	}),
})
headers.set(
	'Content-Disposition',
	new ContentDisposition({ type: 'attachment', filename: 'example.pdf' }),
)
```

## Content-Range

Parse, manipulate and stringify
[`Content-Range` headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Range).

```ts
import { ContentRange } from '@remix-run/headers'

// Parse from headers
let contentRange = ContentRange.from(response.headers.get('content-range'))

contentRange.unit // "bytes"
contentRange.start // 200
contentRange.end // 1000
contentRange.size // 67589

// Unsatisfied range
let unsatisfied = ContentRange.from('bytes */67589')
unsatisfied.start // null
unsatisfied.end // null
unsatisfied.size // 67589

// Construct directly
new ContentRange({ unit: 'bytes', start: 0, end: 499, size: 1000 })

// Use class for type safety when setting Headers values
// via ContentRange's `.toString()` method
let headers = new Headers({
	'Content-Range': new ContentRange({
		unit: 'bytes',
		start: 0,
		end: 499,
		size: 1000,
	}),
})
headers.set(
	'Content-Range',
	new ContentRange({ unit: 'bytes', start: 0, end: 499, size: 1000 }),
)
```

## Content-Type

Parse, manipulate and stringify
[`Content-Type` headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Type).

```ts
import { ContentType } from '@remix-run/headers'

// Parse from headers
let contentType = ContentType.from(request.headers.get('content-type'))

contentType.mediaType // "text/html"
contentType.charset // "utf-8"
contentType.boundary // undefined (or boundary string for multipart)

// Modify and set header
contentType.charset = 'iso-8859-1'
headers.set('Content-Type', contentType)

// Construct directly
new ContentType('text/html; charset=utf-8')
new ContentType({ mediaType: 'text/html', charset: 'utf-8' })

// Use class for type safety when setting Headers values
// via ContentType's `.toString()` method
let headers = new Headers({
	'Content-Type': new ContentType({ mediaType: 'text/html', charset: 'utf-8' }),
})
headers.set(
	'Content-Type',
	new ContentType({ mediaType: 'text/html', charset: 'utf-8' }),
)
```

## Navigation

- [Headers overview](./index.md)
- [Accept headers](./accept-headers.md)
- [Remix package index](../index.md)
