/** Read-only Windows validator. Root substitution follows compaction, never precedes it. */
export function windowsValidator(root: string): string {
  const source = `
$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::ASCII;
function O($s){[Console]::Out.Write("TRJ1|$s|END\u0060r\u0060n");[Environment]::Exit(0)}
function D{O 'ERR|DAMAGED'}
$R=ROOT_LITERAL;
try{
if(![string]::Equals([IO.Path]::GetFullPath($env:TRAJECTA_WRAPPER_DIR),[IO.Path]::GetFullPath("$R\\bin\\"),5)){D}
$c="$R\\current";
try{$a=[IO.File]::GetAttributes($c)}catch{O 'ERR|NOTINSTALLED'}
if($a -band 1040){D}
try{if(([IO.FileInfo]$c).Length -gt 256){D};$b=[IO.File]::ReadAllBytes($c)}catch{O 'ERR|NOTINSTALLED'}
if($b.Length -gt 256){D};$u=[Text.UTF8Encoding]::new($false,$true);$s=$u.GetString($b);
if($s -ceq "uninstalling\u0060n"){O 'SENTINEL'}
$g='[0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9.-]+)?';
if($s -cnotmatch "\\A($g)\u0060n($g|)\u0060n\\z"){D};$v=$Matches[1];$c="$R\\$v";
$a=[IO.File]::GetAttributes($c);if(!($a -band 16) -or ($a -band 1024)){D}
$c+="\\node";if([IO.File]::GetAttributes($c) -band 1040){D}
$n=$u.GetString([IO.File]::ReadAllBytes($c));
if($n -cnotmatch '\\A[^\\x00-\\x1f\\x7f]+\\n\\z'){D};$n=$n.Substring(0,$n.Length-1);
if(![IO.Path]::IsPathRooted($n) -or [IO.Path]::GetPathRoot($n).Length -lt 3){D}
$p=[Diagnostics.Process]::new();$i=[Diagnostics.ProcessStartInfo]::new($n,'--version');
$i.UseShellExecute=$false;$i.RedirectStandardInput=$true;$i.RedirectStandardOutput=$true;$i.RedirectStandardError=$true;$i.CreateNoWindow=$true;$p.StartInfo=$i;$ok=$false;$t=@();
try{[void]$p.Start();$p.StandardInput.Close();$t=@($p.StandardOutput.ReadToEndAsync(),$p.StandardError.ReadToEndAsync());$ok=$p.WaitForExit(10000);if(!$ok){$p.Kill()}}catch{$ok=$false}
try{$d=[Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]$t,2000);$ok=$ok -and $d -and $p.ExitCode -eq 0;
if($ok){$ok=$t[0].Result.Trim() -cmatch '\\Av?(22|24)\\.([0-9]+)\\.[0-9]+\\z' -and ($Matches[1] -eq '24' -or [long]$Matches[2] -ge 19)}}catch{$ok=$false}
try{$p.Dispose()}catch{$ok=$false};if(!$ok){O 'ERR|NODE'}
$z='[^\\x20-\\x7e]|[%!^&|<>"()]';
if($n -cmatch $z){
$a=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('S'),1);
$t=$a.DefineDynamicModule('S').DefineType('S','Public');
$f=$t.DefinePInvokeMethod('GetShortPathNameW','kernel32.dll','Public,Static,PinvokeImpl','Standard',[uint32],@([string],[Text.StringBuilder],[uint32]),'Winapi','Unicode');
$f.SetImplementationFlags(128);$b=[Text.StringBuilder]::new(32768);
if(!$t.CreateType().GetMethod('GetShortPathNameW').Invoke($null,@($n,$b,[uint32]32768))){O 'ERR|NODEPATH'}
$n=$b.ToString();if(!$n -or $n -cmatch $z){O 'ERR|NODEPATH'}
}
O "OK|$v|$n"
}catch{D}
`;
  return source.split("\n").map((line) => line.trim()).join("")
    .replace("ROOT_LITERAL", () => "'" + root.replaceAll("'", "''") + "'");
}
