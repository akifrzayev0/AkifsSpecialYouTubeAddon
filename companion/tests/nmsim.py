"""nmsim.py - launch a native messaging host EXACTLY the way Chrome does on Windows (test helper).

Reproduces chrome/browser/extensions/api/messaging/launch_context_win.cc (Chromium main) for
non-.exe hosts (.bat):

  * two named pipes  \\\\.\\pipe\\chrome.nativeMessaging.{out,in}.<%llx of 64 random bits>
    created with PIPE_ACCESS_{INBOUND,OUTBOUND} | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE, 1 instance, default buffer sizes, 5000 ms timeout
  * command = host path + origin + "--parent-window=<hwnd>", quoted like QuoteForCommandLineToArgvW
  * launched as:  %COMSPEC% /d /s /c "<command>" < <in_pipe> > <out_pipe>
  * start_hidden (STARTF_USESHOWWINDOW + SW_HIDE), current_directory = host dir, no handle inheritance
  * the browser then ConnectNamedPipe()s both pipes (overlapped)

chrome.exe has no console, so Windows creates a new hidden console for cmd.exe; a console driver
passes CREATE_NEW_CONSOLE to get the same result.
"""
import _winapi
import ctypes
import ctypes.wintypes as wt
import json
import os
import queue
import secrets
import struct
import subprocess
import threading
import time

k32 = ctypes.WinDLL("kernel32", use_last_error=True)

MAX_FROM_HOST = 1024 * 1024
PIPE_ACCESS_INBOUND, PIPE_ACCESS_OUTBOUND = 0x1, 0x2
FILE_FLAG_OVERLAPPED, FILE_FLAG_FIRST_PIPE_INSTANCE = 0x40000000, 0x00080000
STARTF_USESHOWWINDOW, SW_HIDE, CREATE_NEW_CONSOLE = 0x1, 0, 0x10


def quote_argvw(arg: str) -> str:
    """Port of base::CommandLine QuoteForCommandLineToArgvWInternal (base/command_line.cc)."""
    if not any(c in arg for c in ' \t\\"'):
        return arg
    out, i = ['"'], 0
    while i < len(arg):
        c = arg[i]
        if c == "\\":
            end = i + 1
            while end < len(arg) and arg[end] == "\\":
                end += 1
            mult = 2 if (end == len(arg) or arg[end] == '"') else 1
            out.append("\\" * ((end - i) * mult))
            i = end
            continue
        out.append('\\"' if c == '"' else c)
        i += 1
    out.append('"')
    return "".join(out)


def has_console() -> bool:
    buf = (wt.DWORD * 4)()
    return k32.GetConsoleProcessList(buf, 4) > 0


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ProcessID", wt.DWORD),
                ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wt.DWORD), ("cntThreads", wt.DWORD),
                ("th32ParentProcessID", wt.DWORD), ("pcPriClassBase", ctypes.c_long), ("dwFlags", wt.DWORD),
                ("szExeFile", ctypes.c_wchar * 260)]


k32.CreateToolhelp32Snapshot.restype = wt.HANDLE
k32.CreateToolhelp32Snapshot.argtypes = [wt.DWORD, wt.DWORD]
k32.Process32FirstW.argtypes = [wt.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
k32.Process32NextW.argtypes = [wt.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
k32.CloseHandle.argtypes = [wt.HANDLE]
k32.OpenProcess.restype = wt.HANDLE
k32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
k32.WaitForSingleObject.argtypes = [wt.HANDLE, wt.DWORD]
k32.WaitForSingleObject.restype = wt.DWORD
k32.TerminateProcess.argtypes = [wt.HANDLE, wt.UINT]


def processes():
    """[(pid, ppid, exe)] via CreateToolhelp32Snapshot."""
    snap = k32.CreateToolhelp32Snapshot(0x2, 0)
    out = []
    e = PROCESSENTRY32W()
    e.dwSize = ctypes.sizeof(e)
    ok = k32.Process32FirstW(snap, ctypes.byref(e))
    while ok:
        out.append((e.th32ProcessID, e.th32ParentProcessID, e.szExeFile))
        ok = k32.Process32NextW(snap, ctypes.byref(e))
    k32.CloseHandle(snap)
    return out


def descendants(root_pid, procs=None):
    procs = procs or processes()
    kids, todo, seen = [], [root_pid], {root_pid}
    while todo:
        p = todo.pop()
        for pid, ppid, exe in procs:
            if ppid == p and pid not in seen:
                seen.add(pid)
                kids.append((pid, ppid, exe))
                todo.append(pid)
    return kids


def wait_pid(pid, timeout_s):
    """Wait for a PID to exit. Returns seconds waited (0.0 if already gone), or None on timeout."""
    h = k32.OpenProcess(0x00100000 | 0x1000, False, pid)  # SYNCHRONIZE | QUERY_LIMITED_INFORMATION
    if not h:
        return 0.0
    t = time.perf_counter()
    r = k32.WaitForSingleObject(h, int(timeout_s * 1000))
    k32.CloseHandle(h)
    return None if r != 0 else time.perf_counter() - t


def terminate_pid(pid, code=9):
    h = k32.OpenProcess(0x0001, False, pid)
    if not h:
        return False
    ok = bool(k32.TerminateProcess(h, code))
    k32.CloseHandle(h)
    return ok


def json_bytes(obj) -> bytes:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


class ChromeLikeHost:
    def __init__(self, host_path, ext_id, parent_window=0, env=None, creation_flags=None, connect_timeout_s=60):
        self.host_path = host_path
        self.origin = f"chrome-extension://{ext_id}/"
        tok = "%x" % secrets.randbits(64)
        self.out_name = "\\\\.\\pipe\\chrome.nativeMessaging.out." + tok
        self.in_name = "\\\\.\\pipe\\chrome.nativeMessaging.in." + tok
        self.h_out = _winapi.CreateNamedPipe(self.out_name, PIPE_ACCESS_INBOUND | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
                                             0, 1, 0, 0, 5000, _winapi.NULL)
        self.h_in = _winapi.CreateNamedPipe(self.in_name, PIPE_ACCESS_OUTBOUND | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
                                            0, 1, 0, 0, 5000, _winapi.NULL)
        command = " ".join([quote_argvw(host_path), quote_argvw(self.origin), quote_argvw(f"--parent-window={parent_window}")])
        self.cmdline = os.environ["COMSPEC"] + ' /d /s /c "' + command + '" < ' + self.in_name + " > " + self.out_name
        si = subprocess.STARTUPINFO()
        si.dwFlags = STARTF_USESHOWWINDOW
        si.wShowWindow = SW_HIDE
        if creation_flags is None:
            creation_flags = CREATE_NEW_CONSOLE if has_console() else 0
        self.t_launch = time.perf_counter()
        hp, ht, pid, _tid = _winapi.CreateProcess(None, self.cmdline, None, None, False, creation_flags, env,
                                                   os.path.dirname(host_path), si)
        _winapi.CloseHandle(ht)
        self.hproc, self.cmd_pid = hp, pid
        self.frames = queue.Queue()
        self.eof_at = None
        self.in_closed = False
        self._connect(self.h_out, connect_timeout_s)
        self._connect(self.h_in, connect_timeout_s)
        self.reader = threading.Thread(target=self._read_loop, daemon=True)
        self.reader.start()

    def _connect(self, h, timeout_s):
        ov = _winapi.ConnectNamedPipe(h, overlapped=True)
        r = _winapi.WaitForMultipleObjects([ov.event, int(self.hproc)], False, int(timeout_s * 1000))
        if r == 0:
            ov.GetOverlappedResult(True)
            return
        ov.cancel()
        raise RuntimeError("host exited before connecting its pipes" if r == 1 else "pipe connect timeout")

    def _read_loop(self):
        buf = bytearray()
        try:
            while True:
                ov, _ = _winapi.ReadFile(self.h_out, 1 << 16, overlapped=True)
                ov.GetOverlappedResult(True)
                data = ov.getbuffer()
                t = time.perf_counter()
                if not data:
                    continue
                buf += data
                while len(buf) >= 4:
                    n = struct.unpack_from("<I", buf)[0]
                    if n > MAX_FROM_HOST:  # what Chrome does: close the port
                        self.frames.put(("bad-header", t, n))
                        return
                    if len(buf) < 4 + n:
                        break
                    self.frames.put(("frame", t, bytes(buf[4:4 + n])))
                    del buf[:4 + n]
        except OSError as e:
            if getattr(e, "winerror", None) not in (109, 232, 995):
                self.frames.put(("error", time.perf_counter(), repr(e)))
        finally:
            self.eof_at = time.perf_counter()
            self.frames.put(("eof", self.eof_at, bytes(buf)))

    def write_raw(self, data: bytes, timeout_s=30):
        ov, _ = _winapi.WriteFile(self.h_in, data, overlapped=True)
        if _winapi.WaitForSingleObject(ov.event, int(timeout_s * 1000)) != 0:
            ov.cancel()
            raise TimeoutError(f"write of {len(data)} bytes not consumed by the host within {timeout_s}s")
        n, _ = ov.GetOverlappedResult(True)
        if n != len(data):
            raise RuntimeError(f"short write {n}/{len(data)}")

    def send(self, obj):
        body = json_bytes(obj)
        self.write_raw(struct.pack("<I", len(body)) + body)

    def recv_json(self, timeout=30):
        kind, t, *rest = self.frames.get(timeout=timeout)
        if kind != "frame":
            raise RuntimeError(f"stream ended: {kind} {rest!r}")
        return t, json.loads(rest[0].decode("utf-8"))

    def close_stdin(self):
        """What the browser does when the port closes: drop its end of the host's stdin pipe."""
        if not self.in_closed:
            _winapi.CloseHandle(self.h_in)
            self.in_closed = True

    def wait_cmd(self, timeout_s):
        r = _winapi.WaitForSingleObject(int(self.hproc), int(timeout_s * 1000))
        return None if r != 0 else _winapi.GetExitCodeProcess(int(self.hproc))

    def close(self):
        self.close_stdin()
        try:
            _winapi.CloseHandle(self.h_out)
        except OSError:
            pass
