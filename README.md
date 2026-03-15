# Berean Standard Bible Browser

Obsidian plugin for browsing the Berean Standard Bible with `bible:` links, a fileless chapter reader, backlink discovery, and passage insertion.

## Status

- Alpha quality. Core workflows are usable, but APIs and UX details may still change.
- Bible text is currently loaded from a configured remote API.
- Local/offline Bible storage is not implemented yet.
- Strong's lookup and quote insertion are available in the current alpha build and depend on a compatible Strong's API.

## Features

- Open chapters from Bible links such as `[[bible:Genesis1|Genesis 1]]`.
- Insert Bible wiki links from a reference prompt.
- Insert passage quotes from verse ranges such as `Revelation 1:5-11`.
- Insert full chapter quotes from chapter references such as `Matthew 26`.
- Look up Strong's entries such as `G3056` or `H7225` in a sidebar.
- Insert Strong's quote blocks from Strong's codes.
- Convert plain citations like `Prov 15:23` into wiki Bible links.
- Convert existing Bible links at the cursor into quote blocks.
- Convert legacy markdown/Bible protocol links across an active note or the whole vault.
- Browse books and chapters in a dedicated Bible Browser view.
- Open chapters in a dedicated reader pane without creating vault files.
- Show backlinks for the active chapter in a dedicated sidebar view.
- Remove legacy `BSB_GRAPH_LINKS` sections from notes.

## Commands

- `Open Bible chapter from reference`
- `Open Bible browser page`
- `Open Bible backlinks sidebar`
- `Lookup Strong's code`
- `Insert Bible wiki link`
- `Insert Bible passage or chapter quote`
- `Insert Strong's quote`
- `Convert Bible citation to wiki Bible link`
- `Turn Bible link at cursor into quote`
- `Convert Bible links to wiki in active note`
- `Convert Bible links to wiki in entire vault`
- `Remove legacy BSB graph section in active note`
- `Remove legacy BSB graph section in entire vault`

## Supported Link Formats

- Preferred canonical form: `[[bible:Genesis1|Genesis 1]]`
- Also accepted for opening/conversion: `[Genesis 1](bible:Genesis1)`, `bible://Genesis%201`, `bible:Deuteronomy25`
- Bare protocol references like `bible:Exodus12:11` can be converted to canonical wiki links
- Parser examples: `1 corinthians 13`, `1Corinthians13`, `Genesis1:1`

## Development Install

1. Run:

```bash
npm install
npm run build
```

2. Copy these files into your vault plugin folder:

- `manifest.json`
- `main.js`
- `styles.css`

3. Enable the plugin in Obsidian Community Plugins.

## Verification

Local verification:

```bash
npm run ci
```

CI runs on pushes and pull requests via [`.github/workflows/ci.yml`](/home/roerick/dev/obsidian/dabar-obsidian/.github/workflows/ci.yml).

Review checklist:

- See [RELEASE_CHECKLIST.md](/home/roerick/dev/obsidian/dabar-obsidian/RELEASE_CHECKLIST.md)

## Configuration

- Default API endpoint: `https://bible.helloao.org/api`
- Default Strong's API endpoint: `https://api.biblesupersearch.com/api`
- Default translation: `BSB`
- Footnote markers can be included in rendered verses and inserted passages
- The plugin does not create Bible chapter files in your vault

## Versioning

- Manifest version: `0.1.0`
- Package version: `0.1.0`
