/** Reviewable bootstrap embeds only the root/lock kernel; no downloaded code runs before verification. */
import * as fs from "node:fs";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { bootstrapEntrySource } from "../product/src/engines.ts";
import { ROOT } from "./engine-lock.ts";
export function bootstrapSource(): string {
  const kernel = ["install-fs.ts", "install-lock.ts"]
    .map((name) =>
      stripTypeScriptTypes(fs.readFileSync(join(ROOT, "product/src", name), "utf8"))
        .replace(/^import[^;]+;/gmu, "")
        .replace(/\bexport /gu, ""),
    )
    .join("\n");
  return bootstrapEntrySource(kernel);
}
export function bootstrapFiles(): Record<string, string> {
  const source = bootstrapSource();
  const sh = `#!/bin/sh
# Download, check the published out-of-band SHA-256, then run. Never curl | sh.
set -eu
node_ok() {
  ver=$("$1" --version 2>/dev/null) || return 1
  ver=\${ver#v}; major=\${ver%%.*}; rest=\${ver#*.}; minor=\${rest%%.*}; patch=\${rest#*.}
  [ -n "$major" ] && [ -n "$minor" ] && [ -n "$patch" ] && [ "$patch" != "$rest" ] || return 1
  case "$major:$minor:$patch" in *[!0-9:]*) return 1;; esac
  case "$major" in 22) [ "$minor" -ge 19 ];; 24) return 0;; *) return 1;; esac
}
chosen=
saved_ifs=$IFS
IFS=:
for folder in $PATH; do
  if [ -n "$folder" ] && node_ok "$folder/node"; then chosen=$folder/node; break; fi
done
IFS=$saved_ifs
if [ -z "$chosen" ]; then
for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME/.fnm/current/bin/node" "$HOME"/.nvm/versions/node/*/bin/node; do
  if [ -n "$candidate" ] && node_ok "$candidate"; then chosen=$candidate; break; fi
done
fi
if [ -z "$chosen" ]; then printf '%s\\n' 'trajecta: need Node 22.19+ or 24 LTS' >&2; exit 1; fi
# exec occurs before acquiring the root lock; no waiter can outlive a writer owner.
exec "$chosen" --experimental-strip-types --input-type=module -e "$(cat <<'TRAJECTA_BOOTSTRAP'
${source}TRAJECTA_BOOTSTRAP
)" -- "$@"
`;
  const ps = `# Download and check the out-of-band SHA-256 before running this script.
$ErrorActionPreference = 'Stop'
$source = @'
${source}'@
$candidates = @($env:PATH.Split(';') | Where-Object { $_ } | ForEach-Object { Join-Path $_ 'node.exe' })
$candidates += @("$env:ProgramFiles\\nodejs\\node.exe", "$env:USERPROFILE\\.volta\\bin\\node.exe", "$env:USERPROFILE\\.fnm\\current\\bin\\node.exe")
$chosen = $null
foreach ($candidate in $candidates) {
  if (-not $candidate) { continue }
  try { $version = (& $candidate --version 2>$null).Trim() } catch { continue }
  if ($LASTEXITCODE -eq 0 -and $version -match '^v?(22|24)\\.(\\d+)\\.\\d+$' -and ($Matches[1] -eq '24' -or [int]$Matches[2] -ge 19)) { $chosen = $candidate; break }
}
if (-not $chosen) { [Console]::Error.WriteLine('trajecta: need Node 22.19+ or 24 LTS'); exit 1 }
# PowerShell only probes, starts the selected Node and waits. It writes no files.
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($source))
# The native argv carries only ASCII base64; PS 5.1 cannot strip quotes from code bytes.
& $chosen --experimental-strip-types --input-type=module -e "await import('data:text/javascript;base64,$encoded#trajecta-bootstrap')" -- @args
exit $LASTEXITCODE
`;
  return { "install.sh": sh, "install.ps1": ps };
}
