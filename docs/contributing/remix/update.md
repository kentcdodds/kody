# Updating Remix package docs

Use this checklist to refresh `docs/contributing/remix/**/*.md` from upstream.

## 1) List packages

```sh
gh api repos/remix-run/remix/contents/packages --jq '.[].name'
```

## 2) Refresh each package README

For each package name, download the README from upstream:

```sh
curl -L "https://raw.githubusercontent.com/remix-run/remix/main/packages/<package>/README.md"
```

Replace the corresponding README content in docs:

- For single-file packages, update `docs/contributing/remix/<package>.md`.
- For split packages, update the README chunks under
  `docs/contributing/remix/<package>/`.

Keep each Markdown file to roughly 200 lines or fewer. If a README grows beyond
that, split it into multiple files and update the package `index.md` to link the
new chunks.

## 3) Refresh component docs

`component` is the only package with a `docs` directory. Sync every file from:

```
https://github.com/remix-run/remix/tree/main/packages/component/docs
```

Update the split files in `docs/contributing/remix/component/` to match
upstream. Keep all docs: `animate`, `components`, `composition`, `context`,
`events`, `getting-started`, `handle`, `interactions`, `patterns`, `spring`,
`styling`, `testing`, `tween`. If any single doc exceeds roughly 200 lines,
split it into multiple files and add links in `component/index.md`.

## 4) Keep the index current

If a package is added or removed upstream, update
`docs/contributing/remix/index.md`:

- Add/remove package rows in the table.
- Update the "Start here" section if new docs are important.
- If a package moves to a folder, update links to `./<package>/index.md`.

## 5) Audit export coverage

Confirm `docs/contributing/remix/index.md` package rows cover all
top-level exports from the installed `remix` package:

```sh
node -e "const fs=require('fs');const pkg=JSON.parse(fs.readFileSync('node_modules/remix/package.json','utf8'));const top=[...new Set(Object.keys(pkg.exports).filter(k=>k!=='./package.json').map(k=>k.slice(2).split('/')[0]))].sort();const idx=fs.readFileSync('docs/contributing/remix/index.md','utf8');const docs=[...new Set([...idx.matchAll(/^\\|\\s*([a-z0-9-]+)\\s*\\|/gm)].map(m=>m[1]).filter(x=>!['Package','--------------------------'].includes(x)))].sort();const missing=top.filter(x=>!docs.includes(x));console.log(missing.length===0?'No missing package docs in index.':'Missing docs for: '+missing.join(', '));"
```

If any package names are missing, add them to `docs/contributing/remix/index.md`
and add the corresponding docs file(s).

## 6) Verify

Run formatting and validation before committing:

```sh
npm run format
npm run validate
```
