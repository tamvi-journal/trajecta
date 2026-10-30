# Download and check the out-of-band SHA-256 before running this script.
$ErrorActionPreference = 'Stop'
$source = @'
import * as fs from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep, join } from 'node:path';
import { createHash, randomBytes, createPublicKey, verify } from 'node:crypto';
import { hostname } from 'node:os';
const TRUST_ANCHOR = "";
const ALLOW_FOUNDATION = false;
function checkpoint(point) {}





const digest = (bytes        )         => createHash("sha256").update(bytes).digest("hex");
function regular(path        )          {
  try {
    if (!fs.lstatSync(path).isFile()) throw new Error(`not a regular file: ${path}`);
    return true;
  } catch (error) {
    if ((error                         ).code === "ENOENT") return false;
    throw error;
  }
}
function safeRoot(root        )       {
  let path = resolve(root);
  for (;;) {
    try {
      const stat = fs.lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe install directory: ${path}`);
    } catch (error) {
      if ((error                         ).code !== "ENOENT") throw error;
    }
    if (dirname(path) === path) break;
    path = dirname(path);
  }
}
function beneath(root        , path        )         {
  const part = relative(resolve(root), resolve(path));
  if (!part || isAbsolute(part) || part === ".." || part.startsWith(".." + sep))
    throw new Error(`path outside install root: ${path}`);
  safeRoot(dirname(path));
  return part.split(sep).join("/");
}
function syncDir(path        )       {
  if (process.platform === "win32") return;
  const fd = fs.openSync(path, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function atomic(path        , bytes        , point        , mode = 0o600)       {
  safeRoot(dirname(path));
  regular(path);
  const tmp = path + ".tmp";
  if (regular(tmp)) fs.unlinkSync(tmp);
  const fd = fs.openSync(tmp, "wx", mode);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  checkpoint(point + ":before-rename");
  fs.renameSync(tmp, path);
  syncDir(dirname(path));
  checkpoint(point + ":after-rename");
}
function readJson(path        )      {
  return regular(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : null;
}
const jsonBytes = (value         )         => Buffer.from(JSON.stringify(value, null, 2) + "\n");








                                                                                      
function owner(bytes        )               {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    return /^[a-f0-9]{32}$/u.test(value.token) &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.hostname === "string" &&
      value.hostname.length &&
      typeof value.created === "string" &&
      Number.isFinite(Date.parse(value.created))
      ? value
      : null;
  } catch {
    return null;
  }
}
function live(record       )          {
  if (record.hostname !== hostname()) return true;
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (error) {
    return (error                         ).code !== "ESRCH";
  }
}
function bytes(path        )                {
  try {
    if (!regular(path)) return null;
    checkpoint("lock-read:before-read:" + path);
    return fs.readFileSync(path);
  } catch (error) {
    const code = (error                         ).code;
    // Another claimant/holder can remove the name after lstat. Windows also
    // refuses an open while an unlink is pending. Neither permits proceeding.
    if (code === "ENOENT") return null;
    if (code === "EPERM" || code === "EACCES") throw busy();
    throw error;
  }
}
const identity = (content        )         => owner(content)?.token ?? digest(content);
function publish(root        , name        )               {
  const record = {
    token: randomBytes(16).toString("hex"),
    pid: process.pid,
    hostname: hostname(),
    created: new Date().toISOString(),
  };
  const tmp = join(root, `.lock.${record.token}.tmp`),
    path = join(root, name);
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, jsonBytes(record));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  checkpoint(name + ":before-link");
  try {
    fs.linkSync(tmp, path);
    syncDir(root);
    checkpoint(name + ":after-link");
    return record;
  } catch (error) {
    if (!["EEXIST", "ENOENT"].includes((error                         ).code ?? "")) throw error;
    return null;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (error) {
      if ((error                         ).code !== "ENOENT") throw error;
    }
  }
}
function heldBy(root        , record       )          {
  const content = bytes(join(root, ".lock"));
  return !!content && owner(content)?.token === record.token;
}
function cleanupClaims(root        , record       )       {
  if (!heldBy(root, record)) throw new Error("install lock changed");
  for (const name of fs.readdirSync(root).sort()) {
    const match = /^\.lock\.claim\.([a-f0-9]{32}|[a-f0-9]{64})\.([1-9][0-9]*)$/u.exec(name);
    if (!match || match[1] === record.token) continue;
    const path = join(root, name);
    try {
      if (!fs.lstatSync(path).isFile()) continue;
      checkpoint("claim-cleanup:before-unlink:" + name);
      fs.unlinkSync(path);
      checkpoint("claim-cleanup:after-unlink:" + name);
    } catch (error) {
      if ((error                         ).code !== "ENOENT") throw error;
    }
  }
  syncDir(root);
}
function cleanupTemps(root        , record       )       {
  if (!heldBy(root, record)) throw new Error("install lock changed");
  for (const name of fs.readdirSync(root).sort()) {
    const match = /^\.lock\.([a-f0-9]{32})\.tmp$/u.exec(name);
    if (!match || match[1] === record.token) continue;
    const path = join(root, name);
    try {
      if (!fs.lstatSync(path).isFile()) continue;
      checkpoint("tmp-cleanup:before-unlink:" + name);
      fs.unlinkSync(path);
      checkpoint("tmp-cleanup:after-unlink:" + name);
    } catch (error) {
      if ((error                         ).code !== "ENOENT") throw error;
    }
  }
  syncDir(root);
}
function release(root        , name        , record       )       {
  if (name !== ".lock") throw new Error("only the install lock may be released");
  if (!heldBy(root, record)) return;
  cleanupClaims(root, record);
  if (!heldBy(root, record)) throw new Error("install lock changed");
  checkpoint("lock:before-release");
  fs.unlinkSync(join(root, name));
  syncDir(root);
  checkpoint("lock:after-release");
}
const busy = () => new Error("another install is running; lock is busy");
const human = () => new Error("install lock cannot be recovered; run trajecta install --break-lock");
function claim(root        , id        , approvedRemote = new Set        ())        {
  for (let n = 1; Number.isSafeInteger(n); n++) {
    const name = `.lock.claim.${id}.${n}`,
      previous = bytes(join(root, name));
    if (previous) {
      const record = owner(previous);
      if (!record) throw human();
      if (record.hostname !== hostname()) {
        if (!approvedRemote.has(record.token)) throw human();
      } else if (live(record)) throw busy();
      continue;
    }
    const claimed = publish(root, name);
    if (!claimed) throw busy(); // A losing contender must not advance to the next claim.
    checkpoint("claim:held");
    return claimed;
  }
  throw human();
}
function removeClaimed(root        , original        , approvedRemote              )       {
  const id = identity(original);
  claim(root, id, approvedRemote);
  const current = bytes(join(root, ".lock"));
  if (!current || identity(current) !== id) throw new Error("lock changed; nothing removed");
  checkpoint("claim:before-unlink");
  fs.unlinkSync(join(root, ".lock"));
  syncDir(root);
  checkpoint("claim:after-unlink");
}
function acquire(root        )        {
  safeRoot(root);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (;;) {
    const held = publish(root, ".lock");
    if (held) {
      cleanupClaims(root, held);
      return held;
    }
    const content = bytes(join(root, ".lock"));
    if (!content) throw busy();
    const record = owner(content);
    if (!record || record.hostname !== hostname()) throw human();
    if (live(record)) throw busy();
    removeClaimed(root, content);
  }
}
async function breakLock(root        , confirm                                       )                {
  safeRoot(root);
  const path = join(root, ".lock"),
    original = bytes(path);
  if (!original) throw new Error("no install lock");
  const record = owner(original),
    stat = fs.statSync(path, { bigint: true }),
    id = identity(original);
  if (record?.hostname === hostname() && live(record)) throw new Error("refusing to break a live lock");
  const approved = new Set        (),
    remoteClaims           = [];
  for (const name of fs.readdirSync(root).sort()) {
    if (!name.startsWith(`.lock.claim.${id}.`)) continue;
    const content = bytes(join(root, name)),
      claimant = content && owner(content);
    if (claimant && claimant.hostname !== hostname()) {
      approved.add(claimant.token);
      remoteClaims.push(
        `${name}: bytes ${content .toString("hex")}; size ${content .length}; mtime_ns ${fs.statSync(join(root, name), { bigint: true }).mtimeNs}`,
      );
    }
  }
  const remote =
    (record && record.hostname !== hostname()) || approved.size
      ? "\nYou are asserting that each shown remote process is not running."
      : "";
  if (
    !(await confirm(
      `${path}: identity ${id}; bytes ${original.toString("hex")}; size ${stat.size}; mtime_ns ${stat.mtimeNs}\n${remoteClaims.join("\n")}${remote}\nType BREAK LOCK to remove this lock: `,
    ))
  )
    throw new Error("lock break refused");
  checkpoint("break:confirmed");
  removeClaimed(root, original, approved);
}

const quote = value => JSON.stringify(value);
async function runVerifiedExtractor(bytes, archive, version, staging) {
  const module = await import('data:text/javascript;base64,' + bytes.toString('base64'));
  const inspected = module.inspect(archive, version);
  return { inspected, extract: () => module.extract(archive, version, staging) };
}
async function runStagedInstall(staging, version, argv) {
  const { pathToFileURL } = await import('node:url');
  const entry = join(staging, 'trajecta-'+version, 'product/src/installer.ts');
  return (await import(pathToFileURL(entry).href)).installStaged(argv);
}
async function runStagedResume(staging, version, argv, token) {
  const { pathToFileURL } = await import('node:url');
  const entry = join(staging, 'trajecta-'+version, 'product/src/uninstall.ts');
  return (await import(pathToFileURL(entry).href)).resumeUninstallHeld(argv, token);
}
async function main() {
  if (!TRUST_ANCHOR) throw Error('no trusted release key configured');
  const argv=process.argv.slice(1), values={};
  let resume=false,noUserBin=false;
  for(let i=0;i<argv.length;) {
    if(argv[i]==='--resume-uninstall') {resume=true;i++;continue;}
    if(argv[i]==='--no-user-bin') {noUserBin=true;i++;continue;}
    if(!['--root','--release','--db','--profile','--work-root','--user-bin'].includes(argv[i]) || argv[i+1]===undefined)
      throw Error('invalid bootstrap option: '+argv[i]);
    values[argv[i]]=argv[i+1];i+=2;
  }
  const root=resolve(values['--root'] || (process.platform==='win32' ? join(process.env.LOCALAPPDATA,'Trajecta') : join(process.env.HOME,'.trajecta')));
  const releaseDir=resolve(values['--release'] || process.cwd()), existed=fs.existsSync(root), held=acquire(root);
  let staging;
  try {
    cleanupTemps(root,held);
    if(!resume && regular(join(root,'current')) && fs.readFileSync(join(root,'current'),'utf8')==='uninstalling\n')
      throw Error('trajecta is being uninstalled; run trajecta uninstall --resume');
    for(const name of fs.readdirSync(root)) if(/^\.staging-[0-9]/u.test(name)){const abandoned=join(root,name);safeRoot(abandoned);fs.rmSync(abandoned,{recursive:true})}
    const raw=fs.readFileSync(join(releaseDir,'release.json'));
    const text=fs.readFileSync(join(releaseDir,'release.json.sig'),'utf8').replace(/\n$/u,'');
    const signature=Buffer.from(text,'base64');
    if(signature.length!==64 || signature.toString('base64')!==text) throw Error('invalid signature');
    const key=createPublicKey({key:Buffer.from(TRUST_ANCHOR,'base64'),format:'der',type:'spki'});
    if(key.asymmetricKeyType!=='ed25519' || !verify(null,raw,key,signature)) throw Error('release signature mismatch');
    const metadata=JSON.parse(raw.toString());
    if(!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(metadata.version)) throw Error('invalid release version');
    const archive=fs.readFileSync(join(releaseDir,'trajecta-'+metadata.version+'.tar.gz'));
    if(archive.length!==metadata.size || digest(archive)!==metadata.sha256) throw Error('release size/SHA-256 mismatch');
    const extractor=fs.readFileSync(join(releaseDir,'trajecta-extract.mjs'));
    if(digest(extractor)!==metadata.extractor_sha256) throw Error('extractor SHA-256 mismatch');
    const verified=await runVerifiedExtractor(extractor,archive,metadata.version);
    if(digest(verified.inspected.manifestBytes)!==metadata.manifest_sha256) throw Error('extracted MANIFEST digest mismatch');
    if(verified.inspected.manifest.artifact==='foundation' && !ALLOW_FOUNDATION) throw Error('foundation is not a release');
    if(verified.inspected.manifest.node!=='>=22.19 <23 || >=24 <25' || JSON.stringify(verified.inspected.manifest.engines)!==JSON.stringify(metadata.engines)) throw Error('release/MANIFEST compatibility mismatch');
    staging=join(root,'.staging-'+metadata.version+'-'+randomBytes(16).toString('hex'));
    // Extract only after the complete metadata pass and signed MANIFEST check.
    const checked=await runVerifiedExtractor(extractor,archive,metadata.version,staging);
    checked.extract();
    const args=['--root',root,'--release',releaseDir];
    if(!resume)args.push('--staged',staging,'--lock-token',held.token);
    for(const name of ['--db','--profile','--work-root','--user-bin']) if(values[name]!==undefined) args.push(name,values[name]);
    if(noUserBin)args.push('--no-user-bin');
    return resume ? await runStagedResume(staging,metadata.version,args,held.token) : await runStagedInstall(staging,metadata.version,args);
  } finally {
    if(staging && fs.existsSync(staging)) fs.rmSync(staging,{recursive:true});
    release(root,'.lock',held);
    if((!existed || resume) && fs.existsSync(root) && !fs.readdirSync(root).length) fs.rmdirSync(root);
  }
}
main().then(code=>process.exitCode=code).catch(error=>{process.stderr.write('trajecta: '+error.message+'\n');process.exitCode=1;});
'@
$candidates = @($env:PATH.Split(';') | Where-Object { $_ } | ForEach-Object { Join-Path $_ 'node.exe' })
$candidates += @("$env:ProgramFiles\nodejs\node.exe", "$env:USERPROFILE\.volta\bin\node.exe", "$env:USERPROFILE\.fnm\current\bin\node.exe")
$chosen = $null
foreach ($candidate in $candidates) {
  if (-not $candidate) { continue }
  try { $version = (& $candidate --version 2>$null).Trim() } catch { continue }
  if ($LASTEXITCODE -eq 0 -and $version -match '^v?(22|24)\.(\d+)\.\d+$' -and ($Matches[1] -eq '24' -or [int]$Matches[2] -ge 19)) { $chosen = $candidate; break }
}
if (-not $chosen) { [Console]::Error.WriteLine('trajecta: need Node 22.19+ or 24 LTS'); exit 1 }
# PowerShell only probes, starts the selected Node and waits. It writes no files.
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($source))
# The native argv carries only ASCII base64; PS 5.1 cannot strip quotes from code bytes.
& $chosen --experimental-strip-types --input-type=module -e "await import('data:text/javascript;base64,$encoded#trajecta-bootstrap')" -- @args
exit $LASTEXITCODE
