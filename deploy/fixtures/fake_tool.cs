// Stand-in for fltmc.exe, git.exe and powershell.exe in deploy/bats.test.js
// (a .cmd stand-in would not do: cmd never returns from a batch file it runs
// without CALL). What it does depends on the name it was copied to:
//   fltmc       exits 0 (already administrator)
//   git         records the call in pulls.txt; the first time, copies FAKE_NEXT
//               over FAKE_BAT (what a pull that changed the bat does); exits FAKE_GIT_RC
//   powershell  records its arguments in ps.txt; exits FAKE_PS_RC
// Files are written in the current folder (the bat's own, after its cd).
using System;
using System.IO;

class FakeTool {
    static int Code(string name) {
        int n;
        return int.TryParse(Environment.GetEnvironmentVariable(name) ?? "0", out n) ? n : 0;
    }

    static int Main() {
        string self = Path.GetFileNameWithoutExtension(Environment.GetCommandLineArgs()[0]).ToLowerInvariant();
        // The raw arguments, as cmd passed them.
        string line = Environment.CommandLine;
        string rest = line.StartsWith("\"") ? line.Substring(line.IndexOf('"', 1) + 1) : (line.IndexOf(' ') < 0 ? "" : line.Substring(line.IndexOf(' ')));
        rest = rest.Trim();
        if (self == "fltmc") return 0;
        if (self == "git") {
            File.AppendAllText("pulls.txt", "git " + rest + Environment.NewLine);
            string next = Environment.GetEnvironmentVariable("FAKE_NEXT");
            string bat = Environment.GetEnvironmentVariable("FAKE_BAT");
            int rc = Code("FAKE_GIT_RC");
            if (rc != 0) { Console.Error.WriteLine("fatal: Not possible to fast-forward, aborting."); return rc; }
            if (!string.IsNullOrEmpty(next) && !string.IsNullOrEmpty(bat) && File.Exists(next) && !File.Exists("pulled.flag")) {
                File.Copy(next, bat, true);
                File.WriteAllText("pulled.flag", "");
                Console.WriteLine("Updating 1234567..89abcde");
            } else {
                Console.WriteLine("Already up to date.");
            }
            return 0;
        }
        if (self == "powershell") {
            File.AppendAllText("ps.txt", "POWERSHELL " + rest + Environment.NewLine);
            return Code("FAKE_PS_RC");
        }
        Console.Error.WriteLine("fake_tool: unknown name " + self);
        return 9;
    }
}
