# Release Checklist

Use this checklist before asking for external review or cutting an alpha release.

## Automated Checks

- `npm ci`
- `npm run ci`
- Confirm CI is green on the current branch/PR

## Manual Functional Checks

- Open a chapter from a prompt such as `Genesis 1`
- Open a chapter by clicking a canonical link such as `[[bible:Genesis1|Genesis 1]]`
- Verify link opening in source mode
- Verify link opening in live preview
- Verify link opening in reading mode
- Verify whitespace next to a live-preview link does not trigger the link
- Insert a verse-range passage such as `Revelation 1:5-11`
- Insert a full chapter such as `Matthew 26`
- Look up a Strong's entry such as `G3056`
- Insert a Strong's quote block such as `H7225`
- Convert plain citations in a selection
- Convert legacy Bible links in the active note
- Convert legacy Bible links in a small test vault or fixture note set
- Open the Bible Browser and navigate between books and chapters
- Open the backlinks sidebar and verify it updates when changing chapters
- Edit API URL and translation settings, then confirm changes apply on Enter or blur

## Regression Focus Areas

- Link interception consistency across source mode, live preview, and reading mode
- Bare `bible:` link conversion without double-wrapping existing links
- Backlink indexing after note create, modify, rename, and delete
- Reader and backlinks views during rapid chapter navigation
- Network failure handling for chapter fetches and invalid settings
- Strong's lookup failure handling and quote insertion formatting

## Release Surface

- README matches current commands and supported workflows
- `manifest.json` and `package.json` version numbers match
- Author and description metadata are set
- Disabled/unfinished features are clearly marked as unavailable

## Non-Release Blockers To Track Separately

- Offline/local Bible storage
- Re-enabling Strong's support
- Large architectural refactors
