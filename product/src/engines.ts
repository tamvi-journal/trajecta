/** The only engine adapter. Engine CLIs own their process and public semantics. */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export type Engine = "identity" | "work";
export function enginePath(engine: Engine, entry = "cli.ts"): string {
  return fileURLToPath(new URL(`../../engines/${engine}/src/${entry}`, import.meta.url));
}
export function engineMetadata(engine: Engine): { name: string; version: string } {
  return JSON.parse(readFileSync(new URL(`../../engines/${engine}/package.json`, import.meta.url), "utf8"));
}
export async function identityApi() {
  return import("../../engines/identity/src/index.ts");
}
/** Public CLI module, also initializes its frozen diagnostic handling. */
export async function prepareIdentityCli() {
  return import("../../engines/identity/src/cli.ts");
}
export async function workApi() {
  return import("../../engines/work/src/index.ts");
}
/** Only verified version roots supplied by install/recovery may reach these public entries. */
export async function identityInstall(versionRoot: string, argv: string[], env: Record<string, string | undefined>) {
  const cli = await import(pathToFileURL(versionRoot + "/engines/identity/src/cli.ts").href);
  const out: Buffer[] = [],
    err: Buffer[] = [];
  const code = await cli.main(argv, {
    env,
    stdout: (bytes: Buffer) => out.push(bytes),
    stderr: (bytes: Buffer) => err.push(bytes),
  });
  return { code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) };
}
export async function workDoctor(versionRoot: string, root: string) {
  const api = await import(pathToFileURL(versionRoot + "/engines/work/src/index.ts").href);
  return new api.TrajectaStore(root).list();
}
/** Install alone supplies a signature-verified extractor, never an engine import bypass. */
export async function runVerifiedExtractor(extractor: Buffer, bytes: Buffer, version: string, staging: string) {
  const module = await import("data:text/javascript;base64," + extractor.toString("base64"));
  return module.extract(bytes, version, staging);
}
/** The verified staged entry executes with the caller's lock-owner PID and lifetime. */
export async function runStagedInstall(staging: string, version: string, argv: string[]): Promise<number> {
  const entry = staging + `/trajecta-${version}/product/src/installer.ts`;
  const module = await import(pathToFileURL(entry).href);
  return module.installStaged(argv);
}
export async function passThrough(engine: Engine, argv: string[]): Promise<void> {
  const entry = enginePath(engine);
  process.argv = [process.execPath, entry, ...argv];
  await import(pathToFileURL(entry).href);
}

/** Pure verifier source; the printed external digest is checked before any recovery import. */
export function recoveryVerifierSource(root: string, anchor: string): string {
  if (!/^[a-f0-9]{64}$/u.test(anchor)) throw new Error("invalid recovery anchor");
  return `const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto');
const root=Buffer.from('${Buffer.from(root, "utf16le").toString("base64")}','base64').toString('utf16le'),dir=p.join(root,'.uninstall');
const sha=b=>c.createHash('sha256').update(b).digest('hex');
const raw=fs.readFileSync(p.join(dir,'DIGESTS.json'));
if(sha(raw)!=='${anchor}')
throw Error('recovery digest list mismatch');
const list=JSON.parse(raw);
for(const [name,hash] of Object.entries(list.files)){if(name.includes('\\\\')||
name.split('/').some(x=>!x||
x==='.'||
x==='..')||
p.isAbsolute(name))
throw Error('unsafe recovery path');
const path=p.join(dir,name);
let parent=p.dirname(path);
while(parent!==dir){if(!fs.lstatSync(parent).isDirectory()||
fs.lstatSync(parent).isSymbolicLink())
throw Error('unsafe recovery directory');
parent=p.dirname(parent)}if(!fs.lstatSync(path).isFile()||
fs.lstatSync(path).isSymbolicLink()||
sha(fs.readFileSync(path))!==hash)
throw Error('recovery file mismatch')}import(require('node:url').pathToFileURL(p.join(dir,'product/src/cli.ts')).href)
.then(m=>m.main(['uninstall','--resume','--root',root]))
.then(code=>process.exitCode=code)
.catch(e=>{console.error('trajecta: '+e.message);
process.exitCode=1});
`;
}

/** Pure, pinned bootstrap source; downloaded imports occur only in the verified adapters. */
export function bootstrapEntrySource(kernel: string): string {
  return `import * as fs from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep, join } from 'node:path';
import { createHash, randomBytes, createPublicKey, verify } from 'node:crypto';
import { hostname } from 'node:os';
const TRUST_ANCHOR = "";
const ALLOW_FOUNDATION = false;
function checkpoint(point) {}
${kernel}
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
  let resume=false;
  for(let i=0;i<argv.length;) {
    if(argv[i]==='--resume-uninstall') {resume=true;i++;continue;}
    if(!['--root','--release','--db','--profile','--work-root'].includes(argv[i]) || argv[i+1]===undefined)
      throw Error('invalid bootstrap option: '+argv[i]);
    values[argv[i]]=argv[i+1];i+=2;
  }
  const root=resolve(values['--root'] || (process.platform==='win32' ? join(process.env.LOCALAPPDATA,'Trajecta') : join(process.env.HOME,'.trajecta')));
  const releaseDir=resolve(values['--release'] || process.cwd()), existed=fs.existsSync(root), held=acquire(root);
  let staging;
  try {
    cleanupTemps(root,held);
    if(!resume && regular(join(root,'current')) && fs.readFileSync(join(root,'current'),'utf8')==='uninstalling\\n')
      throw Error('trajecta is being uninstalled; run trajecta uninstall --resume');
    for(const name of fs.readdirSync(root)) if(/^\\.staging-[0-9]/u.test(name)){const abandoned=join(root,name);safeRoot(abandoned);fs.rmSync(abandoned,{recursive:true})}
    const raw=fs.readFileSync(join(releaseDir,'release.json'));
    const text=fs.readFileSync(join(releaseDir,'release.json.sig'),'utf8').replace(/\\n$/u,'');
    const signature=Buffer.from(text,'base64');
    if(signature.length!==64 || signature.toString('base64')!==text) throw Error('invalid signature');
    const key=createPublicKey({key:Buffer.from(TRUST_ANCHOR,'base64'),format:'der',type:'spki'});
    if(key.asymmetricKeyType!=='ed25519' || !verify(null,raw,key,signature)) throw Error('release signature mismatch');
    const metadata=JSON.parse(raw.toString());
    if(!/^\\d+\\.\\d+\\.\\d+(?:-[A-Za-z0-9.-]+)?$/u.test(metadata.version)) throw Error('invalid release version');
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
    for(const name of ['--db','--profile','--work-root']) if(values[name]!==undefined) args.push(name,values[name]);
    return resume ? await runStagedResume(staging,metadata.version,args,held.token) : await runStagedInstall(staging,metadata.version,args);
  } finally {
    if(staging && fs.existsSync(staging)) fs.rmSync(staging,{recursive:true});
    release(root,'.lock',held);
    if((!existed || resume) && fs.existsSync(root) && !fs.readdirSync(root).length) fs.rmdirSync(root);
  }
}
main().then(code=>process.exitCode=code).catch(error=>{process.stderr.write('trajecta: '+error.message+'\\n');process.exitCode=1;});
`;
}
