// Test-only Win32 evidence helper, compiled inside the isolated test root.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

class NativeM5 {
  static JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16777216 };
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetShortPathName(string path, StringBuilder output, uint length);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool GetVolumeNameForVolumeMountPoint(string path, StringBuilder output, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct ProcessEntry {
    public uint size, usage, pid; public UIntPtr heap; public uint module, threads, parent;
    public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string name;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32First(IntPtr snapshot, ref ProcessEntry row);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry row);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint cb; public string reserved, desktop, title; public uint x,y,w,h,cx,cy,fill,flags;
    public ushort show, reservedSize; public IntPtr reservedPtr, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit,
    uint flags, IntPtr environment, string cwd, ref Startup startup, out ProcessInfo process);
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
  delegate bool Handler(uint control);
  static Handler Ignore = delegate(uint control) { return true; };
  [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(Handler handler, bool add);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GenerateConsoleCtrlEvent(uint control, uint group);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [StructLayout(LayoutKind.Sequential)] struct Coord { public short x,y; public Coord(short a, short b) { x=a; y=b; } }
  [StructLayout(LayoutKind.Sequential)] struct Rect { public short left,top,right,bottom; }
  [StructLayout(LayoutKind.Sequential)] struct ScreenInfo { public Coord size,cursor; public ushort attributes; public Rect window; public Coord maximum; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetConsoleScreenBufferInfo(IntPtr output, out ScreenInfo info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool ReadConsoleOutputCharacter(IntPtr output, StringBuilder data, uint count, Coord origin, out uint read);
  [StructLayout(LayoutKind.Explicit, Size=20)] struct Input {
    [FieldOffset(0)] public ushort type; [FieldOffset(4)] public int down;
    [FieldOffset(8)] public ushort repeat; [FieldOffset(10)] public ushort key;
    [FieldOffset(12)] public ushort scan; [FieldOffset(14)] public char character;
    [FieldOffset(16)] public uint controls;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteConsoleInput(IntPtr input, Input[] records, uint count, out uint written);
  static void Require(bool ok, string operation) { if (!ok) throw new Exception(operation+": Win32 "+Marshal.GetLastWin32Error()); }
  static void Save(string path, object data) { File.WriteAllText(path, Json.Serialize(data)+"\n", new UTF8Encoding(false)); }
  static object Short(string path) {
    StringBuilder b=new StringBuilder(32768); uint size=GetShortPathName(path,b,32768);
    return new { path=path, result=size==0?null:b.ToString(), length=size, error=Marshal.GetLastWin32Error() };
  }
  static object Ancestors(uint pid) {
    IntPtr snapshot=CreateToolhelp32Snapshot(2,0);
    Require(snapshot!=new IntPtr(-1), "process snapshot");
    Dictionary<uint,ProcessEntry> all=new Dictionary<uint,ProcessEntry>();
    try { ProcessEntry p=new ProcessEntry(); p.size=(uint)Marshal.SizeOf(p);
      if(Process32First(snapshot,ref p)) do { all[p.pid]=p; } while(Process32Next(snapshot,ref p));
    } finally { CloseHandle(snapshot); }
    List<object> rows=new List<object>(); HashSet<uint> seen=new HashSet<uint>();
    while(pid!=0 && all.ContainsKey(pid) && seen.Add(pid)) {
      ProcessEntry p=all[pid]; rows.Add(new {pid=p.pid,parent=p.parent,name=p.name}); pid=p.parent;
    }
    return rows;
  }
  static string Screen(IntPtr handle, out ScreenInfo info) {
    Require(GetConsoleScreenBufferInfo(handle,out info),"console buffer");
    int length=info.size.x*(info.cursor.y+1); StringBuilder b=new StringBuilder(length);
    uint read; Require(ReadConsoleOutputCharacter(handle,b,(uint)length,new Coord(0,0),out read),"read console");
    return b.ToString();
  }
  static object ConsoleRun(string config) {
    Dictionary<string,object> c=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(config));
    Startup start=new Startup(); start.cb=(uint)Marshal.SizeOf(start); ProcessInfo p;
    Require(CreateProcess((string)c["application"],new StringBuilder((string)c["command"]),IntPtr.Zero,
      IntPtr.Zero,false,0x10,IntPtr.Zero,(string)c["cwd"],ref start,out p),"new console process");
    IntPtr output=IntPtr.Zero,input=IntPtr.Zero; uint code=259; bool sent=false;
    try {
      FreeConsole(); Require(AttachConsole(p.pid),"attach real console");
      Require(SetConsoleCtrlHandler(Ignore,true),"observer ignores broadcast Ctrl-C");
      output=CreateFile("CONOUT$",0x80000000,3,IntPtr.Zero,3,0,IntPtr.Zero);
      input=CreateFile("CONIN$",0xC0000000,3,IntPtr.Zero,3,0,IntPtr.Zero);
      Require(output!=new IntPtr(-1) && input!=new IntPtr(-1),"console handles");
      Stopwatch watch=Stopwatch.StartNew(); ScreenInfo info; string text="";
      while(watch.ElapsedMilliseconds<20000) {
        text=Screen(output,out info); GetExitCodeProcess(p.process,out code);
        if(text.Contains("(Ctrl+C to stop)"))break;
        if(code!=259)throw new Exception("engine exited before ready: "+code+" screen="+text);
        Thread.Sleep(25);
      }
      Require(text.Contains("(Ctrl+C to stop)"),"real view readiness");
      ScreenInfo beforeInfo; string before=Screen(output,out beforeInfo);
      Require(GenerateConsoleCtrlEvent(0,0),"terminal Ctrl-C broadcast"); sent=true;
      bool prompt=false; string promptText=""; Stopwatch after=Stopwatch.StartNew();
      while(after.ElapsedMilliseconds<10000) {
        text=Screen(output,out info); GetExitCodeProcess(p.process,out code);
        if(text.Contains("Terminate batch job (Y/N)?")) { prompt=true;promptText=text;break; }
        if(code!=259)break;
        Thread.Sleep(25);
      }
      if(prompt) {
        char answer=((string)c["answer"])[0]; List<Input> keys=new List<Input>();
        foreach(char ch in new char[]{answer,'\r'}) foreach(int down in new int[]{1,0})
          keys.Add(new Input{type=1,down=down,repeat=1,key=(ushort)(ch=='\r'?13:Char.ToUpperInvariant(ch)),character=ch});
        uint written; Require(WriteConsoleInput(input,keys.ToArray(),(uint)keys.Count,out written),"answer observed batch prompt");
        Require(written==keys.Count,"all console input records written");
      }
      while(after.ElapsedMilliseconds<15000) {
        GetExitCodeProcess(p.process,out code);if(code!=259)break;Thread.Sleep(25);
      }
      Require(code!=259,"console child termination");
      ScreenInfo finalInfo; string final=Screen(output,out finalInfo);
      return new { child_pid=p.pid, ctrl_c_sent=sent, batch_prompt=prompt, answer=prompt?(string)c["answer"]:null,
        exit_unsigned=code,exit_signed=unchecked((int)code),width=finalInfo.size.x,
        before_utf16le_base64=Convert.ToBase64String(Encoding.Unicode.GetBytes(before)),
        prompt_utf16le_base64=Convert.ToBase64String(Encoding.Unicode.GetBytes(promptText)),
        after_utf16le_base64=Convert.ToBase64String(Encoding.Unicode.GetBytes(final)) };
    } finally {
      GetExitCodeProcess(p.process,out code);
      if(code==259) {
        // Only the still-live console child created above and its descendants.
        ProcessStartInfo cleanup=new ProcessStartInfo(Path.Combine(Environment.SystemDirectory,"taskkill.exe"),"/PID "+p.pid+" /T /F");
        cleanup.UseShellExecute=false;cleanup.CreateNoWindow=true;
        using(Process killer=Process.Start(cleanup))killer.WaitForExit(5000);
        GetExitCodeProcess(p.process,out code);if(code==259)TerminateProcess(p.process,1);
      }
      if(output!=IntPtr.Zero)CloseHandle(output);if(input!=IntPtr.Zero)CloseHandle(input);
      FreeConsole();CloseHandle(p.thread);CloseHandle(p.process);
    }
  }
  static int Main(string[] args) {
    try {
      if(args.Length>0 && args[0]=="--short") { Console.WriteLine(Json.Serialize(Short(args[1])));return 0; }
      if(args.Length>0 && args[0]=="--volume") {
        StringBuilder b=new StringBuilder(1024);Require(GetVolumeNameForVolumeMountPoint(args[1],b,1024),"mounted volume name");
        Console.WriteLine(Json.Serialize(new {volume=b.ToString()}));return 0;
      }
      if(args.Length>0 && args[0]=="--ancestors") { Console.WriteLine(Json.Serialize(Ancestors(UInt32.Parse(args[1]))));return 0; }
      if(args.Length>0 && args[0]=="--console") { Save(args[2],ConsoleRun(args[1]));return 0; }
      string marker=Environment.GetEnvironmentVariable("TEST_NATIVE_MARKER");
      if(Environment.GetEnvironmentVariable("TEST_NATIVE_MODE")=="canary") { File.WriteAllText(marker,"canary ran\n");return 17; }
      string receipt=Environment.GetEnvironmentVariable("TEST_NATIVE_RECEIPT");
      if(args.Length>0 && args[0]=="--pipe-child") {
        File.WriteAllText(receipt+".child",Process.GetCurrentProcess().Id.ToString());
        Console.Out.Write("DESCENDANT_OUT_MUST_NOT_LEAK");Console.Error.Write("DESCENDANT_ERR_MUST_NOT_LEAK");
        Thread.Sleep(60000);return 0;
      }
      if(args.Length==1 && args[0]=="--version") {
        File.WriteAllText(receipt,Process.GetCurrentProcess().Id.ToString());
        ProcessStartInfo child=new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName,"--pipe-child");
        child.UseShellExecute=false; child.CreateNoWindow=true; Process.Start(child);
        Console.Out.Write("PARENT_OUT_MUST_NOT_LEAK");Console.Error.Write("PARENT_ERR_MUST_NOT_LEAK");
        if(Environment.GetEnvironmentVariable("TEST_NATIVE_MODE")=="parent-exit")return 0;
        Thread.Sleep(60000);return 0;
      }
      return 99;
    } catch(Exception error) {
      if(args.Length>2 && args[0]=="--console")Save(args[2],new {error=error.ToString()});
      else Console.Error.WriteLine(error);return 1;
    }
  }
}
