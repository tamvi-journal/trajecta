// Observation only. No acceptance rule from pending identity PR #53 is applied.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

partial class NativeM5 {
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern uint GetConsoleProcessList([Out] uint[] list, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint low, high; }
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetProcessTimes(IntPtr handle, out FileTime created, out FileTime exited,
    out FileTime kernel, out FileTime user);
  [DllImport("user32.dll", SetLastError=true)]
  static extern bool PostMessage(IntPtr window, uint message, IntPtr word, IntPtr value);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);

  class ObservedProcess {
    public uint pid;
    public string name, created_filetime_hex;
    public IntPtr handle;
    public ObservedProcess(uint id) {
      pid=id;handle=OpenProcess(0x101001,false,id);
      Require(handle!=IntPtr.Zero,"open owned console process "+id);
      try {
        name=Process.GetProcessById((int)id).ProcessName;
        FileTime created,exited,kernel,user;
        Require(GetProcessTimes(handle,out created,out exited,out kernel,out user),"process creation time");
        created_filetime_hex=created.high.ToString("x8")+created.low.ToString("x8");
      } catch { CloseHandle(handle);handle=IntPtr.Zero;throw; }
    }
    public object State() {
      uint wait=WaitForSingleObject(handle,0),code;
      Require(wait==0 || wait==258,"query owned process lifetime");
      Require(GetExitCodeProcess(handle,out code),"query owned process exit");
      return new {pid=pid,name=name,created_filetime_hex=created_filetime_hex,
        exited=wait==0,exit_unsigned=wait==0?(object)code:null};
    }
    public bool Exited() { return WaitForSingleObject(handle,0)==0; }
  }
  static object ObserveConsole(string config) {
    Dictionary<string,object> c=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(config));
    string action=(string)c["action"],answer=(string)c["answer"],meta=(string)c["meta"];
    Startup start=new Startup();start.cb=(uint)Marshal.SizeOf(start);ProcessInfo root;
    Require(CreateProcess((string)c["application"],new StringBuilder((string)c["command"]),IntPtr.Zero,
      IntPtr.Zero,false,0x10,IntPtr.Zero,(string)c["cwd"],ref start,out root),"new observation console");
    List<ObservedProcess> clients=new List<ObservedProcess>();
    IntPtr output=IntPtr.Zero,input=IntPtr.Zero,window=IntPtr.Zero;
    List<object> events=new List<object>();List<uint> forced=new List<uint>();
    bool attached=false;Stopwatch clock=Stopwatch.StartNew();
    string before="",promptScreen="",last="",failure=null;int width=0;uint engine=0;
    bool prompt=false,actionSent=false,windowClosed=false;object[] natural=null,final=null;
    int postCloseReadError=0;
    try {
      FreeConsole();
      while(clock.ElapsedMilliseconds<3000) {
        if(AttachConsole(root.pid)){attached=true;break;}
        uint code;GetExitCodeProcess(root.process,out code);
        if(code!=259)break;Thread.Sleep(10);
      }
      Require(attached,"attach observation console");
      Require(SetConsoleCtrlHandler(Ignore,true),"observer ignores Ctrl-C");
      output=CreateFile("CONOUT$",0x80000000,3,IntPtr.Zero,3,0,IntPtr.Zero);
      input=CreateFile("CONIN$",0xC0000000,3,IntPtr.Zero,3,0,IntPtr.Zero);
      Require(output!=new IntPtr(-1) && input!=new IntPtr(-1),"observation console handles");
      ScreenInfo info;bool ready=false;
      while(clock.ElapsedMilliseconds<20000) {
        last=Screen(output,out info);width=info.size.x;
        if(last.Contains("(Ctrl+C to stop)") && File.Exists(meta)){ready=true;break;}
        uint code;GetExitCodeProcess(root.process,out code);
        if(code!=259)throw new Exception("observation child exited before ready: "+code+" screen="+last);
        Thread.Sleep(25);
      }
      Require(ready,"actual view readiness and preload receipt");before=last;
      Dictionary<string,object> m=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(meta));
      engine=Convert.ToUInt32(m["pid"]);
      uint[] ids=new uint[64];uint count=GetConsoleProcessList(ids,(uint)ids.Length);
      Require(count>0 && count<=ids.Length,"enumerate isolated console clients");
      bool foundRoot=false,foundEngine=false;
      for(int i=0;i<count;i++) {
        if(ids[i]==(uint)Process.GetCurrentProcess().Id)continue;
        ObservedProcess p=new ObservedProcess(ids[i]);clients.Add(p);
        foundRoot|=p.pid==root.pid;foundEngine|=p.pid==engine;
      }
      Require(foundRoot && foundEngine,"root and actual engine belong to this console");
      events.Add(new {kind="ready",t_ms=clock.ElapsedMilliseconds,root_pid=root.pid,engine_pid=engine});
      window=GetConsoleWindow();Require(window!=IntPtr.Zero && IsWindow(window),"actual console window");
      if(action=="close-window") {
        // Detach the controller first: closing this window must not kill the observer.
        FreeConsole();attached=false;
        Require(PostMessage(window,0x10,IntPtr.Zero,IntPtr.Zero),"post WM_CLOSE to owned console");
      } else {
        Require(action=="ctrl-c","known observation action");
        Require(GenerateConsoleCtrlEvent(0,0),"real console CTRL_C_EVENT");
      }
      actionSent=true;events.Add(new {kind="action",action=action,t_ms=clock.ElapsedMilliseconds});
      Stopwatch observation=Stopwatch.StartNew();bool answered=false;
      while(observation.ElapsedMilliseconds<12000) {
        ScreenInfo current;
        if(GetConsoleScreenBufferInfo(output,out current)) {
          try { last=Screen(output,out current);width=current.size.x; }
          catch { postCloseReadError=Marshal.GetLastWin32Error(); }
          if(action=="ctrl-c" && !answered && last.Contains("Terminate batch job (Y/N)?")) {
            prompt=true;promptScreen=last;Require(answer=="Y" || answer=="N","known observed answer");
            List<Input> keys=new List<Input>();
            foreach(char ch in new char[]{answer[0],'\r'})foreach(int down in new int[]{1,0})
              keys.Add(new Input{type=1,down=down,repeat=1,key=(ushort)(ch=='\r'?13:ch),character=ch});
            uint written;Require(WriteConsoleInput(input,keys.ToArray(),(uint)keys.Count,out written),"write observed answer");
            Require(written==keys.Count,"all observation input records");answered=true;
            events.Add(new {kind="answer",answer=answer,t_ms=clock.ElapsedMilliseconds});
          }
        } else if(postCloseReadError==0)postCloseReadError=Marshal.GetLastWin32Error();
        if(!windowClosed && !IsWindow(window)) {
          windowClosed=true;events.Add(new {kind="window-gone",t_ms=clock.ElapsedMilliseconds});
        }
        bool gone=true;foreach(ObservedProcess p in clients)if(!p.Exited())gone=false;
        if(gone)break;Thread.Sleep(25);
      }
      natural=clients.ConvertAll(p=>p.State()).ToArray();
      events.Add(new {kind="natural-observation-end",t_ms=clock.ElapsedMilliseconds});
    } catch(Exception error) { failure=error.ToString(); }
    finally {
      // This cleanup is measured separately and cannot count as natural termination.
      foreach(ObservedProcess p in clients)if(!p.Exited()) {
        forced.Add(p.pid);TerminateProcess(p.handle,1);WaitForSingleObject(p.handle,3000);
      }
      if(clients.Count>0)final=clients.ConvertAll(p=>p.State()).ToArray();
      uint code;GetExitCodeProcess(root.process,out code);
      if(code==259) {
        // Startup can fail before the complete client inventory is available.
        ProcessStartInfo cleanup=new ProcessStartInfo(Path.Combine(Environment.SystemDirectory,"taskkill.exe"),"/PID "+root.pid+" /T /F");
        cleanup.UseShellExecute=false;cleanup.CreateNoWindow=true;
        using(Process killer=Process.Start(cleanup))killer.WaitForExit(5000);
      }
      foreach(ObservedProcess p in clients)CloseHandle(p.handle);
      if(output!=IntPtr.Zero && output!=new IntPtr(-1))CloseHandle(output);
      if(input!=IntPtr.Zero && input!=new IntPtr(-1))CloseHandle(input);
      if(attached)FreeConsole();CloseHandle(root.thread);CloseHandle(root.process);
    }
    return new {action=action,requested_answer=answer,root_pid=root.pid,engine_pid=engine,
      action_sent=actionSent,batch_prompt=prompt,window_gone=windowClosed,width=width,
      events=events,natural_processes=natural,forced_cleanup_pids=forced,final_processes=final,
      post_close_screen_error=postCloseReadError,error=failure,
      before_utf16le_base64=Convert.ToBase64String(Encoding.Unicode.GetBytes(before)),
      prompt_utf16le_base64=Convert.ToBase64String(Encoding.Unicode.GetBytes(promptScreen)),
      last_readable_utf16le_base64=Convert.ToBase64String(Encoding.Unicode.GetBytes(last))};
  }
}
