@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "V="
set "P="
(set /p "V=" & set /p "P=") < "%~1"
echo SIZE=%~z1
echo FIELDS
"%TEST_OBSERVER_NODE%" -e "process.stdout.write(JSON.stringify({first:process.env.V,second:process.env.P})+'\n')"
echo MATCHES
"%SystemRoot%\System32\findstr.exe" /r /n /c:"^" "%~1"
echo COUNT
"%SystemRoot%\System32\find.exe" /v /c "" "%~1"
exit /b 0
