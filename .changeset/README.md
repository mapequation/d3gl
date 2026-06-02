# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets).
It records intent-to-release notes that accumulate into version bumps and the
changelog for the published `@mapequation/d3gl` package.

## Adding a changeset

When your change should appear in a release, run:

```sh
corepack pnpm@9.15.9 changeset
```

Pick the bump type and write a short, user-facing summary. While the API is
pre-1.0, prefer `minor` for breaking changes and `patch` for fixes/additions —
under `0.x` semver, a minor bump is allowed to break the API.

The internal `@d3gl/*` workspace packages are `private`, so Changesets ignores
them; only `@mapequation/d3gl` is versioned and published.

## Releasing

CI (`.github/workflows/release.yml`) opens a "Version Packages" pull request that
applies the accumulated changesets. Merging it publishes to npm.
