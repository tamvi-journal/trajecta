import { windowsValidator } from "./windows-validator.ts";

export class WrapperBuildError extends Error {
  constructor(message: string) { super(message); this.name = "WrapperBuildError"; }
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
