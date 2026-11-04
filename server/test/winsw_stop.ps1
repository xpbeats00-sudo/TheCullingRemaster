<#
Starts and stops a process the way WinSW 2.12 does, so tests can check that the
server saves its data when the culling-server service is stopped.

WinSW 2.12 (src/WinSW.Core/Util/ProcessHelper.cs, v2.12.0):
  - runs as a service, i.e. without a console of its own, and starts the child
    with UseShellExecute=false, so the child (node.exe) gets a console of its own;
  - to stop it: AttachConsole(child), GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0),
    FreeConsole(), then WaitForExit(<stoptimeout>, default 15 s) and Kill() if
    the child is still running. stopparentprocessfirst defaults to true.

  winsw_stop.ps1 -Start -Exe node.exe -Arguments 'server.js' -PidFile pid.txt
  winsw_stop.ps1 -Stop -ProcessId 1234 [-TimeoutSeconds 15]
Stop prints "exited <code>" or "killed" (timeout).
#>
param(
    [switch]$Start,
    [switch]$Stop,
    [string]$Exe,
    [string]$Arguments = '',
    [string]$PidFile,
    [int]$ProcessId,
    [int]$TimeoutSeconds = 15
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class WinSWStop {
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(int pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint group);

    public static int Start(string exe, string args) {
        FreeConsole();                      // like a service: no console here
        // WinSW does this too: "ignore Ctrl+C" is inherited by children, so clear it.
        SetConsoleCtrlHandler(IntPtr.Zero, false);
        var psi = new ProcessStartInfo(exe, args);
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;          // a console of its own, without a window
        return Process.Start(psi).Id;
    }

    public static string Stop(int pid, int timeoutMs) {
        var p = Process.GetProcessById(pid);
        var handle = p.Handle;              // open it now: node may exit within milliseconds
        FreeConsole();
        if (!AttachConsole(pid)) return "attach-failed " + Marshal.GetLastWin32Error();
        SetConsoleCtrlHandler(IntPtr.Zero, true);   // WinSW ignores Ctrl+C itself
        GenerateConsoleCtrlEvent(0 /* CTRL_C_EVENT */, 0);
        FreeConsole();
        if (p.WaitForExit(timeoutMs)) return "exited " + p.ExitCode;
        p.Kill();
        return "killed";
    }
}
'@

if ($Start) {
    $id = [WinSWStop]::Start($Exe, $Arguments)
    Set-Content -Path $PidFile -Value $id -Encoding ASCII
} elseif ($Stop) {
    [WinSWStop]::Stop($ProcessId, $TimeoutSeconds * 1000)
} else {
    throw 'Use -Start or -Stop.'
}
