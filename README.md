# Trajecta

Product layer for the SHA-pinned Trajecta identity and work engines.

Private during development. This repository is not a release or an installer yet.

## Foundation development

Use Node 22.19+ or Node 24. Both engines have zero npm dependencies and are
vendored at reviewed commit SHAs with per-file digests.

```sh
node --experimental-strip-types tools/vendor-engines.ts
node --experimental-strip-types product/src/cli.ts version
node --experimental-strip-types tools/build-release.ts
node --experimental-strip-types test/run.ts --fetch
```

The deterministic foundation artifact has no launchers, installer or signing key.
The test runner uses only isolated synthetic stores inside this checkout.
See [the acceptance and deferred-gate record](docs/R4A.md).
