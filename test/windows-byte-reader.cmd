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
set "TEXT_LINE="
for /f "usebackq delims=" %%L in ("%~1") do set "TEXT_LINE=%%L"
echo FOR_FILE
"%TEST_OBSERVER_NODE%" -e "process.stdout.write(JSON.stringify({line:process.env.TEXT_LINE})+'\n')"
set "TEXT_LINE="
for /f "delims=" %%L in ('findstr /r /n /c:"^" "%~1"') do set "TEXT_LINE=%%L"
echo FOR_FINDSTR
"%TEST_OBSERVER_NODE%" -e "process.stdout.write(JSON.stringify({line:process.env.TEXT_LINE})+'\n')"
echo PRINTABLE
"%SystemRoot%\System32\findstr.exe" /p /r /n /c:"^" "%~1"
echo PRINTABLE_STATUS=%errorlevel%
echo DOLLAR
"%SystemRoot%\System32\findstr.exe" /r /c:".$" "%~1"
echo DOLLAR_STATUS=%errorlevel%
echo NONASCII
"%SystemRoot%\System32\findstr.exe" /r /c:"[^ -~]" "%~1"
echo NONASCII_STATUS=%errorlevel%
exit /b 0
