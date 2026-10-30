import { windowsValidator } from "./windows-validator.ts";

export class WrapperBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WrapperBuildError";
  }
}

export function shQuote(value: string): string {
  if (value.includes("\0")) throw new WrapperBuildError("shell path contains NUL");
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function userStub(root: string): string {
  return `#!/bin/sh
R=${shQuote(root)}
[ -f "$R/bin/trajecta" ] || { printf 'trajecta: not installed at %s; run the installer, or remove %s\\n' "$R" "$0" >&2; exit 1; }
exec /bin/sh "$R/bin/trajecta" "$@"
`;
}

export function posixWrapper(root: string, mcp: boolean): string {
  return `#!/bin/sh
R=${shQuote(root)}
damaged() { printf 'trajecta: installation at %s is damaged; run the installer\\n' "$R" >&2; exit 1; }
missing() { printf 'trajecta: not installed at %s; run the installer\\n' "$R" >&2; exit 1; }
resume() { printf '%s\\n' "trajecta is being uninstalled; resume with the command printed by 'trajecta uninstall', or run the installer bootstrap with --resume-uninstall"; }
[ -e "$R/current" ] || { [ -L "$R/current" ] && damaged; missing; }
[ -f "$R/current" ] && [ ! -L "$R/current" ] || damaged
[ -r "$R/current" ] || missing
C=$(/usr/bin/wc -c < "$R/current" 2>/dev/null) || missing
[ "$C" -le 256 ] || damaged
H=$(/usr/bin/od -An -v -tx1 "$R/current" 2>/dev/null) || missing
S=$(printf '%s' "$H" | /usr/bin/tr -d ' \\n')
if [ "$S" = 756e696e7374616c6c696e670a ]; then
${
  mcp
    ? "resume >&2; exit 1"
    : `if [ "$#" = 2 ] && [ "$1" = uninstall ] && [ "$2" = --status ]; then
printf 'trajecta: uninstall in progress at %s\\n' "$R"
resume
exit 3
fi
resume >&2; exit 1`
}
fi
L=0
B=
for B in $H; do
case "$B" in
0a) L=$((L+1));;
2d|2e|3[0-9]|4[1-9a-f]|5[0-9a]|6[1-9a-f]|7[0-9a]) ;;
*) damaged;;
esac
done
[ "$L" = 2 ] && [ "$B" = 0a ] || damaged
{ IFS= read -r V && IFS= read -r P; } < "$R/current" || damaged
version() { printf '%s\\n' "$1" | /usr/bin/grep -Eq '^[0-9]+\\.[0-9]+\\.[0-9]+(-[A-Za-z0-9.-]+)?$'; }
version "$V" || damaged
[ -z "$P" ] || version "$P" || damaged
[ -d "$R/$V" ] && [ ! -L "$R/$V" ] || damaged
[ -f "$R/$V/node" ] && [ ! -L "$R/$V/node" ] || damaged
H=$(/usr/bin/od -An -v -tu1 "$R/$V/node" 2>/dev/null) || damaged
L=0
B=
for B in $H; do
case "$B" in
10) L=$((L+1));;
[0-9]|[12][0-9]|3[01]|127) damaged;;
esac
done
[ "$L" = 1 ] && [ "$B" = 10 ] || damaged
IFS= read -r N < "$R/$V/node" || damaged
case "$N" in /*) ;; *) damaged;; esac
need() { printf '%s: need Node 22.19+ or 24 LTS\\n' ${mcp ? '"${1-}"' : "trajecta"} >&2; exit 1; }
PV=$("$N" --version 2>/dev/null) || need ${mcp ? '"${1-}"' : ""}
PV=\${PV#v}
MA=\${PV%%.*}; T=\${PV#*.}; MI=\${T%%.*}; PA=\${T#*.}
[ "$PV" != "$T" ] && [ "$T" != "$PA" ] && [ -n "$MA" ] && [ -n "$MI" ] && [ -n "$PA" ] || need ${mcp ? '"${1-}"' : ""}
case "$MA:$MI:$PA" in *[!0-9:]*) need ${mcp ? '"${1-}"' : ""};; esac
case "$MA" in 24) ;; 22) [ "$MI" -ge 19 ] 2>/dev/null || need ${mcp ? '"${1-}"' : ""};; *) need ${mcp ? '"${1-}"' : ""};; esac
exec "$N" "$R/$V/product/src/cli.ts" ${mcp ? "mcp " : ""}"$@"
`;
}

export function windowsWrapper(root: string, powershell: string, mcp: boolean): string {
  if (!/^[\x20-\x7e]+$/u.test(powershell) || /[%!^&|<>"()]/u.test(powershell))
    throw new WrapperBuildError("system PowerShell path is not cmd-safe ASCII");
  const encoded = Buffer.from(windowsValidator(root), "utf16le").toString("base64");
  const invoke = `for /f "usebackq delims= eol=\u0060" %%L in (\u0060"${powershell}" -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded} 2^>nul\u0060) do (`;
  if (invoke.length > 8000) throw new WrapperBuildError("Windows validator invocation exceeds 8000 characters");
  return `@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "TRAJECTA_WRAPPER_DIR=%~dp0"
set "wire="
set "count=0"
${invoke}
set /a count+=1
set "wire=%%L"
)
setlocal EnableDelayedExpansion
if not "!count!"=="1" goto invalid
set "a="
set "b="
set "c="
set "d="
set "e="
set "f="
for /f "tokens=1-5* delims=|" %%A in ("!wire!") do (
set "a=%%A"
set "b=%%B"
set "c=%%C"
set "d=%%D"
set "e=%%E"
set "f=%%F"
)
if not "!a!"=="TRJ1" goto invalid
if not "!f!"=="" goto invalid
if "!b!"=="OK" goto ok
if "!b!"=="SENTINEL" goto sentinel
if not "!b!"=="ERR" goto invalid
if not "!d!"=="END" goto invalid
if not "!e!"=="" goto invalid
set "canon=TRJ1|ERR|!c!|END"
if not "!wire!"=="!canon!" goto invalid
if "!c!"=="NOTINSTALLED" goto missing
if "!c!"=="DAMAGED" goto damaged
if "!c!"=="NODE" goto node
if "!c!"=="NODEPATH" goto nodepath
goto invalid
:sentinel
if not "!c!"=="END" goto invalid
if not "!d!!e!"=="" goto invalid
if not "!wire!"=="TRJ1|SENTINEL|END" goto invalid
endlocal
${mcp ? "goto resume" : 'if not "%~1"=="uninstall" goto resume\nif not "%~2"=="--status" goto resume\nif not "%3"=="" goto resume\nfor %%R in ("%~dp0..") do echo trajecta: uninstall in progress at %%~fR\necho trajecta is being uninstalled; resume with the command printed by \'trajecta uninstall\', or run the installer bootstrap with --resume-uninstall\nexit /b 3'}
:resume
echo trajecta is being uninstalled; resume with the command printed by 'trajecta uninstall', or run the installer bootstrap with --resume-uninstall 1>&2
exit /b 1
:ok
if not "!e!"=="END" goto invalid
if "!c!"=="" goto invalid
if "!d!"=="" goto invalid
set "canon=TRJ1|OK|!c!|!d!|END"
if not "!wire!"=="!canon!" goto invalid
echo(!c!|findstr /r /x /c:"[0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*" /c:"[0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*-[A-Za-z0-9.-][A-Za-z0-9.-]*" >nul
if errorlevel 1 goto invalid
for /f "eol=| delims=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 :;\\/._-+=,[]{}?@#$'\u0060~" %%X in ("!d!") do goto invalid
if "!d:~1,2!"==":\\" goto launch
if "!d:~1,2!"==":/" goto launch
if "!d:~0,2!"=="\\\\" goto launch
goto invalid
:launch
endlocal & set "n=%d%" & set "v=%c%"
"%n%" "%~dp0..\\%v%\\product\\src\\cli.ts" ${mcp ? "mcp " : ""}%*
exit /b %errorlevel%
:missing
endlocal
for %%R in ("%~dp0..") do <nul set /p "=${mcp ? "%~1" : "trajecta"}: not installed at %%~fR; run the installer" 1>&2
echo( 1>&2
exit /b 1
:damaged
endlocal
for %%R in ("%~dp0..") do <nul set /p "=${mcp ? "%~1" : "trajecta"}: installation at %%~fR is damaged; run the installer" 1>&2
echo( 1>&2
exit /b 1
:node
endlocal
echo ${mcp ? "%~1" : "trajecta"}: need Node 22.19+ or 24 LTS 1>&2
exit /b 1
:nodepath
endlocal
echo ${mcp ? "%~1" : "trajecta"}: the recorded Node path has no usable short form on this system; reinstall with Node at an ASCII path 1>&2
exit /b 1
:invalid
endlocal
echo ${mcp ? "%~1" : "trajecta"}: cannot validate the installation ^(Windows PowerShell unavailable or blocked^) 1>&2
exit /b 1
`.replaceAll("\n", "\r\n");
}
