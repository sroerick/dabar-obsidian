# Berean Standard Bible Browser (Obsidian Plugin)

This plugin lets you browse the Berean Standard Bible (BSB) in Obsidian with wiki-style `bible:` links and native Obsidian graph/backlink behavior.

## Status

- Super alpha: core workflows are usable, but API schema and UX details may still change.

## Alpha Note

- This plugin is in an early alpha state and may include breaking changes between commits.
- Bible content currently depends on the configured API; local/offline Bible storage is not implemented yet.
- Strong's sidebar/lookup is intentionally disabled for now while that feature is completed.
- If you hit parsing or link-open issues, open an issue with the exact citation text and the command/action you used.

## Features

- Open chapters from wiki Bible links like `[[bible:Genesis1|Genesis 1]]`.
- Adds a left ribbon icon (`book-open`) that opens a Bible Browser page (books + chapters columns).
- Insert formatted passage quotes from references like `Revelation 1:5-11`.
- Convert plain citations like `Prov 15:23` into wiki Bible links (single cursor citation or multiple citations in a selected block).
- Turn an existing Bible link at the cursor into a full quote block.
- Autocomplete in reference dialogs (books/chapters/verses) with Arrow keys, `Tab`, and `Enter`.
- Reader pane opens chapters in a full pane without creating any vault files.
- Dedicated `Bible Backlinks` sidebar view follows the active reader chapter (fileless workflow).
- Markdown-to-wiki migration commands for Bible links.
- Legacy graph-section cleanup commands to remove old `BSB_GRAPH_LINKS` blocks.
- API-backed today, with provider abstraction so local/offline storage can be added later.

## Install (Development)

1. Run:

```bash
npm install
npm run build
```

2. Copy these files into your vault plugin folder:

- `manifest.json`
- `main.js`
- `styles.css` (not used yet)

3. Enable the plugin in Obsidian Community Plugins.

## Release Checks

Run this before publishing code or cutting an alpha build:

```bash
npm ci
npm run ci
```

## Commands

- `Open Bible chapter from reference`
- `Open Bible browser page`
- `Open Bible backlinks sidebar`
- `Insert Bible wiki link`
- `Insert Bible passage quote`
- `Convert Bible citation to wiki Bible link`
- `Turn Bible link at cursor into quote`
- `Convert Markdown Bible links to wiki in active note`
- `Convert Markdown Bible links to wiki in entire vault`
- `Remove legacy BSB graph section in active note`
- `Remove legacy BSB graph section in entire vault`

## Link Formats

- Preferred: `[[bible:Genesis1|Genesis 1]]`
- Also accepted by parser/opening: `[Genesis 1](bible:Genesis1)`, `bible://Genesis%201`, `bible:Deuteronomy25`
- Passage references: `Revelation 1:5-11`
- Parser examples: `1 corinthians 13`, `1Corinthians13`, `Genesis1:1`

## Notes

- Default API endpoint: `https://bible.helloao.org/api`
- Strong's sidebar is currently disabled in alpha while that feature is being finalized.
- Default translation: `BSB`
- The plugin no longer creates Bible chapter files in your vault.
- Manifest and package versions are currently `0.1.0`.
