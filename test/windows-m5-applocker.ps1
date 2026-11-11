# Test only. The Windows VM is discarded after this terminal job.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:GITHUB_REPOSITORY -cne 'tamvi-journal/trajecta' -or $env:RUNNER_OS -cne 'Windows' -or
    $env:GITHUB_EVENT_NAME -cnotin @('push', 'workflow_dispatch', 'pull_request')) {
    throw 'M5-3 requires a trusted GitHub-hosted Windows job'
}
if ($env:GITHUB_EVENT_NAME -ceq 'pull_request') {
    $event = Get-Content -Raw -LiteralPath $env:GITHUB_EVENT_PATH | ConvertFrom-Json
    if ($event.pull_request.head.repo.full_name -cne $env:GITHUB_REPOSITORY) {
        throw 'M5-3 forbids fork pull requests'
    }
}

$dist = New-Item -ItemType Directory -Force -Path 'dist'
$fixtureRoot = New-Item -ItemType Directory -Force -Path '.isolation/tmp/m5-applocker'
$utf8 = [Text.UTF8Encoding]::new($false)
$receipt = [ordered]@{
    head = $env:GITHUB_SHA
    run_id = $env:GITHUB_RUN_ID
    image = $env:ImageVersion
    disposition = 'STOP / M8'
    stage = 'prepare'
}
function Save-Evidence {
    [IO.File]::WriteAllText((Join-Path $dist.FullName 'native-m5-applocker.json'), ($receipt | ConvertTo-Json -Depth 12) + "`n", $utf8)
}

function Invoke-Control([string] $File, [string[]] $Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new($File)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($arg in $Arguments) { $info.ArgumentList.Add($arg) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    $row = [ordered]@{ path = $File; arguments = $Arguments; started = $false }
    try {
        $row.started = $process.Start()
        $process.StandardInput.Close()
        $stdout = [IO.MemoryStream]::new()
        $stderr = [IO.MemoryStream]::new()
        $outTask = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
        $errTask = $process.StandardError.BaseStream.CopyToAsync($stderr)
        if (!$process.WaitForExit(20000)) {
            $process.Kill($true)
            throw "Control process timed out: $File"
        }
        if (![Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($outTask, $errTask), 2000)) {
            throw "Control process did not close its streams: $File"
        }
        $row.exit = $process.ExitCode
        $row.stdout_hex = [Convert]::ToHexString($stdout.ToArray()).ToLowerInvariant()
        $row.stderr_hex = [Convert]::ToHexString($stderr.ToArray()).ToLowerInvariant()
    } catch {
        $row.error = $_.Exception.ToString()
        $cause = $_.Exception
        while ($cause -and $cause -isnot [ComponentModel.Win32Exception]) { $cause = $cause.InnerException }
        if ($cause) { $row.win32_error = $cause.NativeErrorCode }
    } finally {
        $process.Dispose()
    }
    return $row
}

function Assert-Control($Row, [string] $Expected) {
    if (!$Row.started -or $Row.exit -ne 0 -or $Row.stderr_hex -ne '' -or
        [Text.Encoding]::UTF8.GetString([Convert]::FromHexString($Row.stdout_hex)).Trim() -cne $Expected) {
        throw "Positive control failed: $($Row.path)"
    }
}

try {
    $cmd = Join-Path $env:SystemRoot 'System32\cmd.exe'
    $pinned = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $pwsh = Join-Path $PSHOME 'pwsh.exe'
    $nodes = @($env:TEST_M5_NODE22, $env:TEST_M5_NODE24)
    $harness = Join-Path $PWD 'test/windows-m5-applocker.ts'
    $fixtures = @()
    $receipt.preparation = @()
    for ($index = 0; $index -lt $nodes.Count; $index++) {
        $config = Join-Path $fixtureRoot.FullName "node-$index.json"
        $fixtures += $config
        $prepared = Invoke-Control $nodes[$index] @('--experimental-strip-types', $harness, 'prepare', $config)
        $receipt.preparation += $prepared
        if (!$prepared.started -or $prepared.exit -ne 0) { throw "Could not prepare Node fixture $index" }
    }

    $receipt.stage = 'policy read-back and service'
    # Load directly in pwsh so the read-back does not depend on the pinned host.
    $module = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules\AppLocker\AppLocker.psd1'
    Import-Module $module -SkipEditionCheck
    $before = Get-AppLockerPolicy -Effective -Xml
    [IO.File]::WriteAllText((Join-Path $dist.FullName 'applocker-effective-before.xml'), $before, $utf8)
    if (([xml]$before).AppLockerPolicy.RuleCollection) { throw 'Runner has an existing AppLocker policy' }
    $channel = 'Microsoft-Windows-AppLocker/EXE and DLL'
    $latest = Get-WinEvent -LogName $channel -MaxEvents 1 -ErrorAction SilentlyContinue
    $afterRecord = if ($latest) { $latest.RecordId } else { 0 }

    # Permit exact binaries needed by this job and its artifact/checkout actions.
    $allow = @($cmd, $pwsh, $pinned) + $nodes
    $worker = $null
    $ancestor = $PID
    for ($depth = 0; $ancestor -and $depth -lt 16; $depth++) {
        $processRow = Get-CimInstance Win32_Process -Filter "ProcessId = $ancestor"
        if (!$processRow) { break }
        if ($processRow.Name -ieq 'Runner.Worker.exe') {
            $worker = Split-Path (Split-Path $processRow.ExecutablePath -Parent) -Parent
            break
        }
        $ancestor = $processRow.ParentProcessId
    }
    if (!$worker) { throw 'Cannot identify the GitHub Actions worker for artifact upload' }
    $allow += @(Get-ChildItem (Join-Path $worker 'externals/node*/bin/node.exe') -File | ForEach-Object FullName)
    $allow += (Get-Command git.exe -CommandType Application | Select-Object -First 1).Source
    $allow += @(Join-Path $env:SystemRoot 'System32/conhost.exe')
    $allow = @($allow | Sort-Object -Unique)
    foreach ($file in $allow) {
        if (!$file -or !(Test-Path -LiteralPath $file -PathType Leaf) -or $file.Contains('*') -or $file.Contains('%')) {
            throw "Non-exact executable allow path: $file"
        }
    }
    $policy = [xml]'<AppLockerPolicy Version="1"><RuleCollection Type="Exe" EnforcementMode="Enabled"/></AppLockerPolicy>'
    $collection = $policy.SelectSingleNode('/AppLockerPolicy/RuleCollection')
    function Add-PathRule([string] $Action, [string] $Path) {
        $rule = $policy.CreateElement('FilePathRule')
        $rule.SetAttribute('Id', [guid]::NewGuid().ToString())
        $rule.SetAttribute('Name', "$Action $Path")
        $rule.SetAttribute('Description', 'Trajecta M5-3 disposable hosted fixture')
        $rule.SetAttribute('UserOrGroupSid', 'S-1-1-0')
        $rule.SetAttribute('Action', $Action)
        $conditions = $policy.CreateElement('Conditions')
        $condition = $policy.CreateElement('FilePathCondition')
        $condition.SetAttribute('Path', $Path)
        [void]$conditions.AppendChild($condition)
        [void]$rule.AppendChild($conditions)
        [void]$collection.AppendChild($rule)
    }
    foreach ($file in $allow) { Add-PathRule Allow $file }
    Add-PathRule Deny $pinned
    $policyPath = Join-Path $dist.FullName 'applocker-requested.xml'
    [IO.File]::WriteAllText($policyPath, $policy.OuterXml, $utf8)
    $receipt.service_before = (Get-Service AppIDSvc).Status.ToString()
    Start-Service AppIDSvc
    (Get-Service AppIDSvc).WaitForStatus('Running', [TimeSpan]::FromSeconds(15))
    Set-AppLockerPolicy -XmlPolicy $policyPath
    $local = Get-AppLockerPolicy -Local -Xml
    [IO.File]::WriteAllText((Join-Path $dist.FullName 'applocker-local.xml'), $local, $utf8)
    $receipt.read_back = @()
    $readBackDeadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $effective = Get-AppLockerPolicy -Effective -Xml
        $exe = ([xml]$effective).SelectSingleNode('/AppLockerPolicy/RuleCollection[@Type="Exe"]')
        $receipt.read_back += @{ utc = [DateTime]::UtcNow.ToString('O'); mode = $exe.EnforcementMode }
        if ($exe.EnforcementMode -ceq 'Enabled') { break }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $readBackDeadline)
    [IO.File]::WriteAllText((Join-Path $dist.FullName 'applocker-effective.xml'), $effective, $utf8)
    $receipt.service = (Get-Service AppIDSvc).Status.ToString()
    $receipt.mode = if ($exe) { $exe.EnforcementMode } else { $null }
    Save-Evidence
    if ($receipt.mode -cne 'Enabled' -or $receipt.service -cne 'Running') { throw 'AppLocker Enforce/service read-back failed' }
    $expectedRules = @($collection.FilePathRule | ForEach-Object { "$($_.Id)|$($_.Action)|$($_.UserOrGroupSid)|$($_.Conditions.FilePathCondition.Path)" } | Sort-Object)
    $actualRules = @($exe.FilePathRule | ForEach-Object { "$($_.Id)|$($_.Action)|$($_.UserOrGroupSid)|$($_.Conditions.FilePathCondition.Path)" } | Sort-Object)
    if ($exe.ChildNodes.Count -ne $expectedRules.Count -or (Compare-Object $expectedRules $actualRules)) {
        throw 'Effective executable rules differ from the closed requested policy'
    }

    $receipt.stage = 'positive controls'
    $receipt.positive = @()
    $positive = Invoke-Control $cmd @('/d', '/q', '/c', 'echo m5-cmd')
    $receipt.positive += $positive
    Assert-Control $positive 'm5-cmd'
    $positive = Invoke-Control $pwsh @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Console]::WriteLine("m5-pwsh")')
    $receipt.positive += $positive
    Assert-Control $positive 'm5-pwsh'
    foreach ($node in $nodes) {
        $positive = Invoke-Control $node @('-e', 'console.log("m5-node")')
        $receipt.positive += $positive
        Assert-Control $positive 'm5-node'
    }

    $receipt.stage = 'pinned host deny and matching event'
    $receipt.negative = Invoke-Control $pinned @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0')
    if ($receipt.negative.started -or !$receipt.negative.win32_error) { throw 'Pinned host launch was not blocked' }
    $denyEvent = $null
    $observedDenials = @{}
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (!$denyEvent -and [DateTime]::UtcNow -lt $deadline) {
        $denials = Get-WinEvent -FilterHashtable @{LogName=$channel; Id=8004} -MaxEvents 32 -ErrorAction SilentlyContinue
        foreach ($denial in $denials) {
            if ($denial.RecordId -le $afterRecord) { continue }
            $observedDenials[$denial.RecordId] = $denial.ToXml()
            $xml = [xml]$denial.ToXml()
            $path = [string]($xml.Event.UserData.RuleAndFileData.FilePath)
            $path = $path -ireplace '^%OSDRIVE%', $env:SystemDrive
            $path = $path -ireplace '^%(WINDIR|SYSTEMROOT)%', $env:SystemRoot
            $path = $path -ireplace '^%SYSTEM32%', (Join-Path $env:SystemRoot 'System32')
            if ($path -ieq $pinned) { $denyEvent = $denial; break }
        }
        if (!$denyEvent) { Start-Sleep -Milliseconds 200 }
    }
    $receipt.observed_denials = @($observedDenials.Values)
    if (!$denyEvent) { throw 'No new AppLocker 8004 event matches the pinned executable' }
    [IO.File]::WriteAllText((Join-Path $dist.FullName 'applocker-deny-event.xml'), $denyEvent.ToXml(), $utf8)
    $receipt.deny_event = @{ id = $denyEvent.Id; record_id = $denyEvent.RecordId; path = $pinned }

    $receipt.stage = 'wrapper controls'
    $receipt.wrappers = @()
    for ($index = 0; $index -lt $nodes.Count; $index++) {
        $result = Invoke-Control $nodes[$index] @('--experimental-strip-types', $harness, 'blocked', $fixtures[$index])
        $receipt.wrappers += $result
        if (!$result.started -or $result.exit -ne 0) { throw "Wrapper fixture $index failed" }
    }
    $receipt.disposition = 'AppLocker proven on hosted Windows'
    $receipt.stage = 'complete'
} catch {
    $receipt.error = $_.ToString()
    throw "STOP M5-3 / M8 at $($receipt.stage): $($receipt.error)"
} finally {
    Save-Evidence
}
