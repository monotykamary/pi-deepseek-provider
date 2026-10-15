# Changelog

## 3.0.11

- Pin Pi SDK development dependencies to 1.2.0 while retaining wildcard host peers; verify real manifest loading, lifecycle and native/bundled Pi hosts offline.

## 3.0.10

- Quiet startup sync: background `/models` revalidation runs only with an API key, only when the disk cache is older than 1 hour (`PI_PROVIDER_SYNC_TTL_MS`, `0` = always), missing, or fetched with a different key, and only in one pi process at a time (lock file next to the cache). Failed refreshes back off for 5 minutes; sessions that skip adopt a cache refreshed by another process.
- Never store the API key: key changes are detected via a salted sha256 fingerprint in `cache/deepseek-models.sync.json`. The cache file format is unchanged.
- Write the model cache atomically; the per-session revalidation (first DeepSeek request) stays fire-and-forget with every rejection swallowed.
- Add vitest coverage for the sync policy and the revalidation integration.

## 3.0.8

- Pin Pi SDK development dependencies to 1.0.0 while retaining wildcard host peers.
- Verify real manifest loading, provider catalogs, startup/shutdown and native/bundled Pi hosts offline.
- Exercise real transport adapters with Unicode text, tool calls, empty responses, usage, request hooks and cancellation; no live provider calls.

## 3.0.7

- Test against Pi 0.99.0 and declare host-provided modules as wildcard peers.
- Replace no-op checks with scoped TypeScript checks and an offline real-Pi loader, provider-registration, and session-lifecycle smoke test.
