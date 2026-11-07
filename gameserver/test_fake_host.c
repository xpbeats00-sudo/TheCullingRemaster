/* Stand-ins for the launcher and the host game, for test_agent.py: the agent
 * starts "Func.Launcher.exe", which starts "Victory.exe" (or the exe of
 * -FuncVictoryExe=) with its command line and environment, as the real
 * launcher does. The fake host, given CULLING_NETPLAY_CONTROL:
 *   - writes cmdline.txt and env.txt there (what the agent gave it);
 *   - writes listening: "port=<CULLING_NETPLAY_PORT + shift>\n" (shift from
 *     fake_host.cfg next to it: "shift=1" plays a host whose port was taken);
 *   - runs until killed, or until fake.exit appears in its control folder.
 * Built twice by test_agent.py: /DLAUNCHER for the launcher. No game runs.
 */
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

static void dir_of_self(wchar_t *out)
{
    wchar_t *slash;
    GetModuleFileNameW(0, out, MAX_PATH);
    slash = wcsrchr(out, L'\\');
    if (slash)
        slash[1] = 0;
}

#ifdef LAUNCHER
int wmain(int argc, wchar_t **argv)
{
    wchar_t exe[MAX_PATH], *cmd, *rest = GetCommandLineW();
    STARTUPINFOW si = { sizeof(si) };
    PROCESS_INFORMATION pi;
    DWORD code = 1;
    int i, quoted = 0;
    dir_of_self(exe);
    wcscat_s(exe, MAX_PATH, L"Victory.exe");
    for (i = 1; i < argc; i++)
        if (!wcsncmp(argv[i], L"-FuncVictoryExe=", 16))
            wcscpy_s(exe, MAX_PATH, argv[i] + 16);
    /* The rest of the command line after argv[0], passed on as it is. */
    for (; *rest && (quoted || *rest != L' '); rest++)
        if (*rest == L'"')
            quoted = !quoted;
    cmd = (wchar_t *)calloc(wcslen(rest) + MAX_PATH + 8, sizeof(wchar_t));
    swprintf(cmd, wcslen(rest) + MAX_PATH + 8, L"\"%s\"%s", exe, rest);
    if (!CreateProcessW(exe, cmd, 0, 0, FALSE, 0, 0, 0, &si, &pi))
        return 3;
    WaitForSingleObject(pi.hProcess, INFINITE);
    GetExitCodeProcess(pi.hProcess, &code);
    return (int)code;
}
#else
static void write_utf8(const wchar_t *dir, const wchar_t *name, const wchar_t *text, size_t n)
{
    wchar_t path[MAX_PATH * 2];
    char *buf;
    int len;
    HANDLE h;
    DWORD w;
    swprintf(path, MAX_PATH * 2, L"%s\\%s", dir, name);
    len = WideCharToMultiByte(CP_UTF8, 0, text, (int)n, 0, 0, 0, 0);
    buf = (char *)malloc((size_t)len + 1);
    WideCharToMultiByte(CP_UTF8, 0, text, (int)n, buf, len, 0, 0);
    h = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_DELETE, 0, CREATE_ALWAYS, 0, 0);
    if (h != INVALID_HANDLE_VALUE) {
        WriteFile(h, buf, (DWORD)len, &w, 0);
        CloseHandle(h);
    }
    free(buf);
}

int wmain(void)
{
    wchar_t ctl[MAX_PATH], cfgpath[MAX_PATH], portv[16], line[64], stop[MAX_PATH * 2];
    wchar_t *env, *p, *out;
    size_t n = 0;
    int port = 7777, shift = 0;
    FILE *cfg;
    if (!GetEnvironmentVariableW(L"CULLING_NETPLAY_CONTROL", ctl, MAX_PATH))
        return 2;
    dir_of_self(cfgpath);
    wcscat_s(cfgpath, MAX_PATH, L"fake_host.cfg");
    if (!_wfopen_s(&cfg, cfgpath, L"r") && cfg) {
        char s[64];
        while (fgets(s, sizeof(s), cfg))
            sscanf_s(s, "shift=%d", &shift);
        fclose(cfg);
    }
    write_utf8(ctl, L"cmdline.txt", GetCommandLineW(), wcslen(GetCommandLineW()));
    env = GetEnvironmentStringsW();
    for (p = env; *p; p += wcslen(p) + 1)
        n += wcslen(p) + 1;
    out = (wchar_t *)calloc(n + 1, sizeof(wchar_t));
    for (p = env, n = 0; *p; p += wcslen(p) + 1) {
        wcscpy_s(out + n, wcslen(p) + 1, p);
        n += wcslen(p);
        out[n++] = L'\n';
    }
    write_utf8(ctl, L"env.txt", out, n);
    if (GetEnvironmentVariableW(L"CULLING_NETPLAY_PORT", portv, 16))
        port = _wtoi(portv);
    swprintf(line, 64, L"port=%d\n", port + shift);
    write_utf8(ctl, L"listening", line, wcslen(line));
    swprintf(stop, MAX_PATH * 2, L"%s\\fake.exit", ctl);
    for (;;) {
        Sleep(100);
        if (GetFileAttributesW(stop) != INVALID_FILE_ATTRIBUTES)
            return 0;
    }
}
#endif
