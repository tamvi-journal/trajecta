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

Update checks are explicit. Use `trajecta update --check`, or
`trajecta update --check --from <directory>` for an offline mirror containing
`index.json`, `index.json.sig` and `v<version>/` release files. Node's fetch does
not use HTTPS_PROXY unless Node's own proxy option is enabled. The supported
route around that is `--from`. Both paths require the same signatures, expiry
and replay checks. The production trust anchor remains empty and checks refuse
until a release key is explicitly authorized.

`trajecta update --reset-state` requires a terminal and the exact typed
confirmation `RESET UPDATE STATE`. It trusts the published rotation history
as it stands and reconstructs the floor from authenticated installed MANIFESTs
and the accepted index. It cannot reconstruct a higher sequence previously
seen but never installed. A reset can therefore permit replay until a newer
index is accepted. Full TUF roles remain deferred for the developer beta.

This change supplies trust verification and checking. Staging, store inspection,
activation, migration and the update changelog display are supplied by 4d-2.
The release build requires `--index-sequence <positive safe integer>` and ships
CHANGELOG.md. A foundation build omits the sequence and cannot be installed in
production. The six-platform artifact comparator covers the sequence input.

A full uninstall without typed trust-reset consent keeps update-state.json.
Malformed replay state is retained and reported. Restore a valid saved state
before asking the product to reset it. Consent lasts only for the current run.
A crash can require a fresh typed confirmation on the next install.

Before publishing, Q9 must settle renewal of the immutable signed index assets,
or an explicit expiry horizon and refresh requirement. Expired indexes refuse.
