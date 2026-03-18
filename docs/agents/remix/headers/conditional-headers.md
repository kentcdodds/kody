# Conditionals and ranges

Source: https://github.com/remix-run/remix/tree/main/packages/headers

## If-Match

Parse, manipulate and stringify
[`If-Match` headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-Match).

Implements `Set<etag>`.

```ts
import { IfMatch } from '@remix-run/headers'

// Parse from headers
let ifMatch = IfMatch.from(request.headers.get('if-match'))

ifMatch.tags // ['"67ab43"', '"54ed21"']
ifMatch.has('"67ab43"') // true
ifMatch.matches('"67ab43"') // true (checks precondition)
ifMatch.matches('"abc123"') // false

// Note: Uses strong comparison only (weak ETags never match)
let weak = IfMatch.from('W/"67ab43"')
weak.matches('W/"67ab43"') // false

// Modify and set header
ifMatch.add('"newetag"')
ifMatch.delete('"67ab43"')
headers.set('If-Match', ifMatch)

// Construct directly
new IfMatch(['abc123', 'def456'])

// Use class for type safety when setting Headers values
// via IfMatch's `.toString()` method
let headers = new Headers({
	'If-Match': new IfMatch(['"abc123"', '"def456"']),
})
headers.set('If-Match', new IfMatch(['"abc123"', '"def456"']))
```

## If-None-Match

Parse, manipulate and stringify
[`If-None-Match` headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-None-Match).

Implements `Set<etag>`.

```ts
import { IfNoneMatch } from '@remix-run/headers'

// Parse from headers
let ifNoneMatch = IfNoneMatch.from(request.headers.get('if-none-match'))

ifNoneMatch.tags // ['"67ab43"', '"54ed21"']
ifNoneMatch.has('"67ab43"') // true
ifNoneMatch.matches('"67ab43"') // true

// Supports weak comparison (unlike If-Match)
let weak = IfNoneMatch.from('W/"67ab43"')
weak.matches('W/"67ab43"') // true

// Modify and set header
ifNoneMatch.add('"newetag"')
ifNoneMatch.delete('"67ab43"')
headers.set('If-None-Match', ifNoneMatch)

// Construct directly
new IfNoneMatch(['abc123'])

// Use class for type safety when setting Headers values
// via IfNoneMatch's `.toString()` method
let headers = new Headers({
	'If-None-Match': new IfNoneMatch(['"abc123"']),
})
headers.set('If-None-Match', new IfNoneMatch(['"abc123"']))
```

## If-Range

Parse, manipulate and stringify
[`If-Range` headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-Range).

```ts
import { IfRange } from '@remix-run/headers'

// Parse from headers
let ifRange = IfRange.from(request.headers.get('if-range'))

// With HTTP date
ifRange.matches({ lastModified: 1609459200000 }) // true
ifRange.matches({ lastModified: new Date('2021-01-01') }) // true

// With ETag
let etagHeader = IfRange.from('"67ab43"')
etagHeader.matches({ etag: '"67ab43"' }) // true

// Empty/null returns empty instance (range proceeds unconditionally)
let empty = IfRange.from(null)
empty.matches({ etag: '"any"' }) // true

// Construct directly
new IfRange('"abc123"')

// Use class for type safety when setting Headers values
// via IfRange's `.toString()` method
let headers = new Headers({
	'If-Range': new IfRange('"abc123"'),
})
headers.set('If-Range', new IfRange('"abc123"'))
```

## Range

Parse, manipulate and stringify
[`Range` headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Range).

```ts
import { Range } from '@remix-run/headers'

// Parse from headers
let range = Range.from(request.headers.get('range'))

range.unit // "bytes"
range.ranges // [{ start: 200, end: 1000 }]
range.canSatisfy(2000) // true
range.canSatisfy(500) // false
range.normalize(2000) // [{ start: 200, end: 1000 }]

// Multiple ranges
let multi = Range.from('bytes=0-499, 1000-1499')
multi.ranges.length // 2

// Suffix range (last N bytes)
let suffix = Range.from('bytes=-500')
suffix.normalize(2000) // [{ start: 1500, end: 1999 }]

// Construct directly
new Range({ unit: 'bytes', ranges: [{ start: 0, end: 999 }] })

// Use class for type safety when setting Headers values
// via Range's `.toString()` method
let headers = new Headers({
	Range: new Range({ unit: 'bytes', ranges: [{ start: 0, end: 999 }] }),
})
headers.set(
	'Range',
	new Range({ unit: 'bytes', ranges: [{ start: 0, end: 999 }] }),
)
```

## Vary

Parse, manipulate and stringify
[`Vary` headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Vary).

Implements `Set<headerName>`.

```ts
import { Vary } from '@remix-run/headers'

// Parse from headers
let vary = Vary.from(response.headers.get('vary'))

vary.headerNames // ['accept-encoding', 'accept-language']
vary.has('Accept-Encoding') // true (case-insensitive)
vary.size // 2

// Modify and set header
vary.add('User-Agent')
vary.delete('Accept-Language')
headers.set('Vary', vary)

// Construct directly
new Vary('Accept-Encoding, Accept-Language')
new Vary(['Accept-Encoding', 'Accept-Language'])
new Vary({ headerNames: ['Accept-Encoding', 'Accept-Language'] })

// Use class for type safety when setting Headers values
// via Vary's `.toString()` method
let headers = new Headers({
	Vary: new Vary(['Accept-Encoding', 'Accept-Language']),
})
headers.set('Vary', new Vary(['Accept-Encoding', 'Accept-Language']))
```

## Navigation

- [Headers overview](./index.md)
- [Cookie headers](./cookie-headers.md)
- [Remix package index](../index.md)
