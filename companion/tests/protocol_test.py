"""protocol_test.py - end-to-end tests of the companion host, launched exactly like Chrome launches it.

Runs against the INSTALLED host by default (%LOCALAPPDATA%\\AkifYouTubeAddon\\host\\host.bat). The host is
started with AKIF_HOST_TEST=1, so open / pickFolder / updateTools validate their input but never open a
window or change anything. Downloads are real (YouTube, small files) and go to --out; media files are
deleted at the end unless --keep is given.

usage:  python -X utf8 companion/tests/protocol_test.py [--host PATH] [--out DIR] [--only a,b] [--keep]
"""
import argparse
import json
import os
import queue
import re
import shutil
import struct
import subprocess
import sys
import time
import traceback

if sys.stdout:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.dont_write_bytecode = True  # no __pycache__ next to the sources
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import nmsim  # noqa: E402

EXT_ID = "oicpmbpfimnoolnhfgdocfjelknjlcif"
DEFAULT_HOST = os.path.join(os.environ.get("LOCALAPPDATA", ""), "AkifYouTubeAddon", "host", "host.bat")
TERMINAL = ("done", "error", "canceled")
ZOO = "jNQXAC9IVRw"  # "Me at the zoo", 19 s
CAR = "KrLj6nc516A"  # 26 dubbed audio tracks, 22 caption tracks
AZ = "HmPl0CItGQA"  # Azerbaijani title
PLAYLIST = "PL6IaIsEjSbf96XFRuNccS_RuEXwNdsoEu"  # 4 items, "JODA15"
JOB_PROCS = ("yt-dlp.exe", "python.exe", "ffmpeg.exe", "ffprobe.exe")


def watch(vid):
    return f"https://www.youtube.com/watch?v={vid}"


class Fail(AssertionError):
    pass


class Skip(Exception):
    pass


def check(cond, msg):
    if not cond:
        raise Fail(msg if isinstance(msg, str) else json.dumps(msg, ensure_ascii=False)[:1500])


def ffprobe(path):
    exe = shutil.which("ffprobe") or "ffprobe"
    r = subprocess.run([exe, "-v", "error", "-show_streams", "-show_format", "-of", "json", path], capture_output=True, timeout=120)
    check(r.returncode == 0, f"ffprobe failed on {path}: {r.stderr.decode('utf-8', 'replace')[:400]}")
    return json.loads(r.stdout.decode("utf-8"))


def streams(probe, kind, attached=False):
    return [s for s in probe["streams"] if s.get("codec_type") == kind and bool(s.get("disposition", {}).get("attached_pic")) == attached]


def monotonic(values):
    return all(b >= a for a, b in zip(values, values[1:]))


def max_in_window(times, window):
    """Largest number of events inside any window of `window` seconds."""
    best, j = 0, 0
    for i in range(len(times)):
        while times[i] - times[j] > window:
            j += 1
        best = max(best, i - j + 1)
    return best


class Session:
    """One host instance = one chrome.runtime.connectNative() port."""

    def __init__(self, host_bat, extra_env=None):
        env = dict(os.environ)
        env["AKIF_HOST_TEST"] = "1"
        for k, v in (extra_env or {}).items():
            # Windows variable names are case-insensitive (os.environ has ONEDRIVE): replace, never duplicate
            for old in [x for x in env if x.upper() == k.upper()]:
                del env[old]
            env[k] = v
        self.h = nmsim.ChromeLikeHost(host_bat, EXT_ID, env=env)
        self.seq = 0
        self.events = {}  # jobId -> [(t, event)]
        self.loose = []  # responses nobody asked for (re=null)

    def _next(self, timeout):
        try:
            return self.h.recv_json(max(0.05, timeout))
        except queue.Empty:
            raise TimeoutError(f"no message from the host within {timeout:.0f} s") from None

    def _route(self, t, m):
        if "event" in m:
            self.events.setdefault(m.get("jobId"), []).append((t, m))
            return True
        return False

    def request(self, type_, timeout=90, **params):
        self.seq += 1
        rid = f"r{self.seq}"
        self.h.send({"id": rid, "type": type_, **params})
        deadline = time.time() + timeout
        while True:
            t, m = self._next(deadline - time.time())
            if self._route(t, m):
                continue
            if m.get("re") == rid:
                return m
            self.loose.append(m)

    def read_loose(self, timeout=10):
        """Next response that is not an event and not an answer to a pending request."""
        if self.loose:
            return self.loose.pop(0)
        deadline = time.time() + timeout
        while True:
            t, m = self._next(deadline - time.time())
            if not self._route(t, m):
                return m

    def job_events(self, job_id):
        return [e for _, e in self.events.get(job_id, [])]

    def wait_job(self, job_id, timeout=300, until=None):
        deadline = time.time() + timeout
        while True:
            evs = self.events.get(job_id, [])
            if any(e["event"] in TERMINAL for _, e in evs):
                return [e for _, e in evs]
            if until and until([e for _, e in evs]):
                return [e for _, e in evs]
            left = deadline - time.time()
            if left <= 0:
                raise TimeoutError(f"job {job_id}: no terminal event within {timeout} s (last: {[e['event'] for _, e in evs][-5:]})")
            t, m = self._next(left)
            if not self._route(t, m):
                self.loose.append(m)

    def start(self, job_id, task):
        r = self.request("start", jobId=job_id, task=task)
        check(r.get("ok") is True, f"start {job_id} rejected: {r}")
        return r

    def run_job(self, job_id, task, timeout=300):
        self.start(job_id, task)
        return self.wait_job(job_id, timeout)

    def drain(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            try:
                t, m = self.h.recv_json(0.1)
            except queue.Empty:
                continue
            except RuntimeError:
                return
            if not self._route(t, m):
                self.loose.append(m)

    def close(self, wait=15):
        self.h.close_stdin()
        code = self.h.wait_cmd(wait)
        self.h.close()
        return code


def job_tree(cmd_pid):
    return [(pid, exe) for pid, ppid, exe in nmsim.descendants(cmd_pid) if exe.lower() in JOB_PROCS]


def survivors(pids):
    alive = {p for p, _, _ in nmsim.processes()}
    left = sorted(p for p in pids if p in alive)
    r = subprocess.run(["tasklist", "/FO", "CSV", "/NH"], capture_output=True)
    rows = r.stdout.decode("utf-8", "replace").splitlines()
    tl = [row for row in rows if any(f'"{p}"' in row for p in pids)]
    return left, tl


def finished_ok(evs):
    last = evs[-1]
    check(last["event"] == "done", f"expected done, got {last}")
    return last


def progress_checks(s, job_id):
    """Progress events exist, percent is monotonic and in range, and the rate limit holds:
    at most 2 events in any rolling second (0.95 s window to tolerate receive jitter)."""
    timed = [(t, e) for t, e in s.events.get(job_id, []) if e["event"] == "progress"]
    prog = [e for _, e in timed]
    check(prog, "no progress events")
    pcts = [p["percent"] for p in prog]
    check(monotonic(pcts) and all(0 <= p <= 100 for p in pcts), f"percent not monotonic/in range: {pcts}")
    rate = max_in_window([t for t, _ in timed], 0.95)
    check(rate <= 2, f"progress not throttled: {rate} events within one second")
    stages = {p["stage"] for p in prog}
    check(stages <= {"video", "audio", "download", "subtitles"}, f"progress stages {stages} (spec 8.2 allows video/audio/download/subtitles)")
    return prog


# =============================================================================== tests
class Ctx:
    def __init__(self, args):
        self.args = args
        self.s = None
        self.files = []

    def dir(self, name):
        d = os.path.join(self.args.out, name)
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d, exist_ok=True)
        return d


def t_hello(c):
    t0 = time.perf_counter()
    r = c.s.request("hello")
    ms = round((time.perf_counter() - t0) * 1000)
    check(r.get("ok") is True, r)
    check(r["name"] == "akif-youtube-addon-host" and r["protocol"] == 1 and r["version"] == "1.0.0", r)
    tools = r["tools"]
    for k in ("ytdlp", "ffmpeg", "deno"):
        check(tools[k]["path"] and tools[k]["version"], f"{k}: {tools[k]}")
    check(os.path.isdir(r["downloadsDir"]), r["downloadsDir"])
    check(r["defaultDir"] == os.path.join(r["downloadsDir"], "Akif YouTube"), r["defaultDir"])
    r2 = c.s.request("hello", subfolder="My: Videos/2026")
    check(r2["defaultDir"] == os.path.join(r["downloadsDir"], "My - Videos", "2026"), r2["defaultDir"])
    c.deno_pid = r["pid"]
    return {"helloMs": ms, "host": r["version"], "ytdlp": f"{tools['ytdlp']['version']} ({tools['ytdlp'].get('variant')})",
            "ffmpeg": tools["ffmpeg"]["version"], "deno": tools["deno"]["version"], "defaultDir": r["defaultDir"]}


def t_ping(c):
    rtts = []
    for _ in range(20):
        t0 = time.perf_counter()
        r = c.s.request("ping")
        rtts.append((time.perf_counter() - t0) * 1000)
        check(r == {"re": r["re"], "ok": True}, r)
    return {"pings": 20, "medianRttMs": round(sorted(rtts)[10], 2)}


def t_protocol_errors(c):
    r = c.s.request("definitelyNotAType")
    check(r.get("ok") is False and r.get("code") == "unknown_type", r)
    c.s.h.write_raw(struct.pack("<I", 5) + b"{oops")  # invalid JSON
    m = c.s.read_loose()
    check(m.get("re") is None and m.get("ok") is False and m.get("code") == "bad_request", m)
    c.s.h.send({"type": "ping"})  # no id
    m = c.s.read_loose()
    check(m.get("ok") is False and m.get("code") == "bad_request", m)
    r = c.s.request("cancel", jobId="no-such-job")
    check(r.get("ok") is True and r.get("found") is False, r)
    r = c.s.request("ping")
    check(r.get("ok") is True, "host still answers after bad input")
    return {"checked": 5}


def t_bad_tasks(c):
    out = c.dir("bad")
    ok = {"kind": "video", "videoId": ZOO, "url": watch(ZOO), "playlist": False, "outputDir": out}
    cases = {
        "non-youtube url": {**ok, "url": "https://evil.example.com/watch?v=jNQXAC9IVRw"},
        "http url": {**ok, "url": "http://www.youtube.com/watch?v=jNQXAC9IVRw"},
        "extra url params": {**ok, "url": watch(ZOO) + "&list=PLx"},
        "shell metachars in url": {**ok, "url": watch(ZOO) + "&calc"},
        "videoId mismatch": {**ok, "videoId": "dQw4w9WgXcQ"},
        "playlist flag on watch url": {**ok, "playlist": True},
        "unknown kind": {**ok, "kind": "exe"},
        "relative outputDir": {**ok, "outputDir": "videos"},
        "outputDir with ..": {**ok, "outputDir": out + "\\..\\..\\x"},
        "outputDir with |": {**ok, "outputDir": out + "\\a|b"},
        "device outputDir": {**ok, "outputDir": "\\\\.\\pipe\\x"},
        "height as string": {**ok, "height": "1080"},
        "container avi": {**ok, "container": "avi"},
        "audioLang injection": {**ok, "audioLang": "en]+(b"},
        "bitrate 100": {**ok, "kind": "audio", "bitrate": 100},
        "audioFormat exe": {**ok, "kind": "audio", "audioFormat": "exe"},
        "reversed section": {**ok, "section": {"start": 9, "end": 3}},
        "gif without section": {**ok, "kind": "gif"},
        "gif 90 s": {**ok, "kind": "gif", "section": {"start": 0, "end": 90}},
        "subtitle without subLang": {**ok, "kind": "subtitle"},
        "subFormat doc": {**ok, "kind": "subtitle", "subLang": "en", "subFormat": "doc"},
        "cookies not a string": {**ok, "cookies": {"a": 1}},
        "filenameStyle path": {**ok, "filenameStyle": "..\\x"},
        "task not an object": "rm -rf /",
    }
    bad = []
    for i, (name, task) in enumerate(cases.items()):
        r = c.s.request("start", jobId=f"bad{i}", task=task)
        if r.get("ok") is not False or r.get("code") != "bad_task":
            bad.append((name, r))
    for name, job_id in (("jobId with spaces", "a b"), ("jobId too long", "x" * 65), ("jobId not a string", 7)):
        r = c.s.request("start", jobId=job_id, task=ok)
        if r.get("ok") is not False or r.get("code") != "bad_task":
            bad.append((name, r))
    c.s.drain(0.5)
    stray = [j for j in c.s.events if str(j).startswith("bad")]
    check(not bad, f"accepted: {bad}")
    check(not stray, f"events for rejected jobs: {stray}")
    check(not os.path.exists(os.path.join(out, "a|b")), "nothing created")
    return {"rejected": len(cases) + 3}


def t_video_mp4(c):
    out = c.dir("video")
    task = {"kind": "video", "videoId": ZOO, "url": watch(ZOO), "playlist": False, "outputDir": out, "subfolder": "",
            "filenameStyle": "title", "cookies": None, "height": 240, "width": 320, "hdr": False, "fps": 15,
            "container": "mp4", "codec": "auto", "audioLang": None, "embedThumbnail": True, "embedMetadata": True,
            "embedChapters": True, "embedSubtitles": False, "section": None, "preciseCut": False}
    t0 = time.time()
    evs = c.s.run_job("v240", task, 300)
    done = finished_ok(evs)
    path = done["filePath"]
    check(os.path.basename(path) == "Me at the zoo (240p).mp4", path)
    check(os.path.isfile(path) and os.path.getsize(path) == done["fileSize"], done)
    p = ffprobe(path)
    v, a = streams(p, "video"), streams(p, "audio")
    check(v and v[0]["width"] == 320 and v[0]["height"] == 240, v)
    check(a, "no audio stream")
    dur = float(p["format"]["duration"])
    check(18.5 <= dur <= 19.6, f"duration {dur}")
    check("mp4" in p["format"]["format_name"], p["format"]["format_name"])
    infos = [e for e in evs if e["event"] == "info"]
    check(infos and infos[0]["title"] == "Me at the zoo" and infos[0]["videoId"] == ZOO, infos)
    prog = progress_checks(c.s, "v240")
    stages = [e["stage"] for e in evs if e["event"] == "stage"]
    check("merge" in stages, f"stages {stages}")
    files = [e for e in evs if e["event"] == "file"]
    check(len(files) == 1 and files[0]["path"] == path, f"file events {files}")
    check(evs.index(files[0]) < evs.index(done), "file event before done")
    check(not os.path.exists(os.path.join(out, ".akif-tmp")), "temp dir left behind")
    c.video_file = path
    c.files.append(path)
    return {"file": os.path.basename(path), "bytes": done["fileSize"], "codecs": f"{v[0]['codec_name']}+{a[0]['codec_name']}",
            "durationS": round(dur, 2), "coverEmbedded": bool(streams(p, "video", attached=True)), "stages": stages,
            "progress": [p["percent"] for p in prog], "seconds": round(time.time() - t0, 1)}


def t_video_section_precise(c):
    """Clip 5-12 s with preciseCut (re-encoded at the cut points, exact duration) via ffmpeg -progress."""
    out = c.dir("clip")
    task = {"kind": "video", "videoId": ZOO, "url": watch(ZOO), "outputDir": out, "height": 240, "width": 320, "hdr": False, "fps": 15,
            "container": "mp4", "section": {"start": 5, "end": 12}, "preciseCut": True, "embedThumbnail": False}
    evs = c.s.run_job("clip1", task, 300)
    done = finished_ok(evs)
    path = done["filePath"]
    check(os.path.basename(path) == "Me at the zoo (240p) (clip 00-05 - 00-12).mp4", path)
    p = ffprobe(path)
    dur = float(p["format"]["duration"])
    check(abs(dur - 7.0) <= 0.15, f"clip duration {dur}")
    check(streams(p, "video") and streams(p, "audio"), "clip lacks video or audio")
    prog = progress_checks(c.s, "clip1")
    c.files.append(path)
    return {"file": os.path.basename(path), "durationS": round(dur, 3), "codec": streams(p, "video")[0]["codec_name"],
            "progress": [p["percent"] for p in prog]}


def t_error_unavailable(c):
    """A video that does not exist: one `error` event (code unavailable), no retry, temp dir removed."""
    out = c.dir("err")
    evs = c.s.run_job("e1", {"kind": "video", "videoId": "xxxxxxxxxxx", "url": watch("xxxxxxxxxxx"), "outputDir": out, "height": 240}, 180)
    last = evs[-1]
    check(last["event"] == "error" and last["code"] == "unavailable", last)
    check(sum(e["event"] in TERMINAL for e in evs) == 1, "exactly one terminal event")
    check(last.get("message") and isinstance(last.get("detail"), str), last)
    check(not os.path.exists(os.path.join(out, ".akif-tmp")), "temp dir left behind")
    return {"code": last["code"], "message": last["message"]}


def t_retry_transient(c):
    """First attempt fails with a real network error (test hook: dead proxy), the host retries once and succeeds."""
    out = c.dir("retry")
    s = Session(c.args.host, {"AKIF_TEST_FAIL_FIRST": "1"})
    try:
        evs = s.run_job("r1", {"kind": "audio", "videoId": ZOO, "url": watch(ZOO), "outputDir": out, "audioFormat": "m4a",
                                "embedThumbnail": False, "embedMetadata": False}, 300)
    finally:
        s.close()
    done = finished_ok(evs)
    c.files.append(done["filePath"])
    log = os.path.join(os.path.dirname(os.path.dirname(c.args.host)), "logs", "host.log")
    retried = [ln for ln in open(log, encoding="utf-8", errors="replace").read().splitlines()[-400:] if "job r1:" in ln and "retrying once" in ln]
    check(retried, "the log shows no retry")
    return {"file": os.path.basename(done["filePath"]), "logLine": retried[-1].split(" WARN ")[-1][:200]}


def t_audio_sections(c):
    """mp3 192k 3-9 s (one exact encode), m4a 3-9 s (copy + host cut) and opus 3-9 s (copy, cut inside
    yt-dlp's remux) running concurrently - three jobs sharing one output folder and .akif-tmp."""
    out = c.dir("audio")
    base = {"kind": "audio", "videoId": ZOO, "url": watch(ZOO), "playlist": False, "outputDir": out, "section": {"start": 3, "end": 9},
            "embedThumbnail": True, "embedMetadata": True, "audioLang": None}
    c.s.start("a-mp3", {**base, "audioFormat": "mp3", "bitrate": 192})
    c.s.start("a-m4a", {**base, "audioFormat": "m4a", "bitrate": 192})
    c.s.start("a-opus", {**base, "audioFormat": "opus", "bitrate": 192})
    dup = c.s.request("start", jobId="a-mp3", task={**base, "audioFormat": "mp3"})
    check(dup.get("ok") is False and dup.get("code") == "bad_task", f"duplicate jobId accepted: {dup}")
    e1 = c.s.wait_job("a-mp3", 300)
    e2 = c.s.wait_job("a-m4a", 300)
    e3 = c.s.wait_job("a-opus", 300)
    res = {}
    for name, job_id, evs, codec in (("mp3", "a-mp3", e1, "mp3"), ("m4a", "a-m4a", e2, "aac"), ("opus", "a-opus", e3, "opus")):
        done = finished_ok(evs)
        path = done["filePath"]
        check(os.path.basename(path) == f"Me at the zoo (clip 00-03 - 00-09).{name}", path)
        p = ffprobe(path)
        a = streams(p, "audio")
        check(a and a[0]["codec_name"] == codec, a)
        dur = float(p["format"]["duration"])
        check(abs(dur - 6.0) <= 0.15, f"{name} duration {dur} (expected 6.0 +- 0.15)")
        cover = bool(streams(p, "video", attached=True))
        r = {"file": os.path.basename(path), "durationS": round(dur, 3), "cover": cover}
        if name == "mp3":
            br = int(a[0].get("bit_rate") or p["format"].get("bit_rate") or 0)
            check(180000 <= br <= 205000, f"mp3 bitrate {br}")
            r["bitRate"] = br
        stages = [e["stage"] for e in evs if e["event"] == "stage"]
        check(("cut" if name == "m4a" else "extract") in stages, f"{name} stages {stages}")
        check(cover, f"{name} lost its embedded cover")
        r["stages"] = stages
        r["progress"] = [p["percent"] for p in progress_checks(c.s, job_id)]
        c.files.append(path)
        res[name] = r
    check(not os.path.exists(os.path.join(out, ".akif-tmp")), "temp dir left behind")
    return res


def t_subtitles(c):
    out = c.dir("subs")
    base = {"kind": "subtitle", "videoId": CAR, "url": watch(CAR), "playlist": False, "outputDir": out, "subLang": "en",
            "subAuto": False, "subTranslateTo": None}
    c.s.start("s-srt", {**base, "subFormat": "srt"})
    c.s.start("s-txt", {**base, "subFormat": "txt"})
    e1 = c.s.wait_job("s-srt", 300)
    e2 = c.s.wait_job("s-txt", 300)
    d1, d2 = finished_ok(e1), finished_ok(e2)
    title = next(e["title"] for e in e1 if e["event"] == "info")
    srt_path, txt_path = d1["filePath"], d2["filePath"]
    check(os.path.basename(srt_path) == f"{title} (en).srt", srt_path)
    check(os.path.basename(txt_path) == f"{title} (en).txt", txt_path)
    srt = open(srt_path, encoding="utf-8").read()
    txt = open(txt_path, encoding="utf-8").read()
    check(re.match(r"1\r?\n\d\d:\d\d:\d\d,\d{3} --> \d\d:\d\d:\d\d,\d{3}\r?\n", srt), srt[:200])
    cues = srt.count("-->")
    check(cues >= 20, f"only {cues} cues")
    check("\u200b" not in srt and "\u200b" not in txt, "zero-width spaces left")
    lines = [ln for ln in txt.splitlines() if ln.strip()]
    check(len(lines) >= 10 and "-->" not in txt and "<font" not in txt.lower(), txt[:300])
    check(not os.path.exists(os.path.join(out, ".akif-tmp")), "temp dir left behind")
    return {"srt": os.path.basename(srt_path), "cues": cues, "txt": os.path.basename(txt_path), "txtLines": len(lines),
            "firstTxtLine": lines[0][:60]}


def t_gif(c):
    out = c.dir("gif")
    task = {"kind": "gif", "videoId": ZOO, "url": watch(ZOO), "playlist": False, "outputDir": out, "section": {"start": 3, "end": 8},
            "gifWidth": 240, "gifFps": 10}
    evs = c.s.run_job("g1", task, 300)
    done = finished_ok(evs)
    path = done["filePath"]
    check(os.path.basename(path) == "Me at the zoo (clip 00-03 - 00-08).gif", path)
    p = ffprobe(path)
    v = streams(p, "video")
    check(v and v[0]["codec_name"] == "gif" and v[0]["width"] <= 240, v)
    dur = float(p["format"].get("duration") or v[0].get("duration") or 0)
    check(4.3 <= dur <= 5.7, f"gif duration {dur}")
    stages = [e["stage"] for e in evs if e["event"] == "stage"]
    check("gif" in stages, f"stages {stages}")
    prog = progress_checks(c.s, "g1")
    c.files.append(path)
    return {"file": os.path.basename(path), "bytes": done["fileSize"], "size": f"{v[0]['width']}x{v[0]['height']}", "durationS": dur,
            "stages": stages, "progress": [f"{p['stage']}:{p['percent']}" for p in prog]}


def wait_bytes(s, job_id, min_bytes, timeout=180):
    def flowing(evs):
        return any(e["event"] == "progress" and (e.get("downloaded") or 0) >= min_bytes for e in evs)
    evs = s.wait_job(job_id, timeout, until=flowing)
    check(not any(e["event"] in TERMINAL for e in evs), f"job ended early: {evs[-1]}")
    return evs


def t_cancel(c):
    out = c.dir("cancel")
    task = {"kind": "video", "videoId": CAR, "url": watch(CAR), "playlist": False, "outputDir": out, "height": 1080, "width": 1920,
            "hdr": False, "container": "mp4", "codec": "auto"}
    c.s.start("c1080", task)
    wait_bytes(c.s, "c1080", 2_000_000)
    tree = job_tree(c.s.h.cmd_pid)
    check(any(exe.lower() == "yt-dlp.exe" for _, exe in tree), f"no yt-dlp in tree {tree}")
    tmp_before = os.listdir(os.path.join(out, ".akif-tmp")) if os.path.isdir(os.path.join(out, ".akif-tmp")) else []
    t0 = time.perf_counter()
    r = c.s.request("cancel", jobId="c1080")
    check(r.get("ok") is True and "found" not in r, r)
    evs = c.s.wait_job("c1080", 60)
    ms = round((time.perf_counter() - t0) * 1000)
    check(evs[-1]["event"] == "canceled", evs[-1])
    c.s.drain(1.5)
    after = c.s.job_events("c1080")
    check(after[-1]["event"] == "canceled" and sum(e["event"] in TERMINAL for e in after) == 1, "events after canceled")
    left, tl = survivors([p for p, _ in tree])
    check(not left, f"processes survived the cancel: {left} {tl}")
    check(not os.path.exists(os.path.join(out, ".akif-tmp")), "temp dir left behind")
    check(not [f for f in os.listdir(out)], f"files left: {os.listdir(out)}")
    return {"treeBeforeCancel": [f"{exe}:{pid}" for pid, exe in tree], "tempBefore": tmp_before, "cancelToCanceledMs": ms,
            "survivors": left, "tasklistMatches": tl}


def t_cancel_while_starting(c):
    """A cancel that arrives while the start still waits for its output folder (test hook: a 1.5 s slow folder)
    finds the job ({} instead of {found:false}); the start is still answered {outDir}, then `canceled` is the
    job's only event and nothing is launched. A second start with the same id during the wait is refused."""
    out = c.dir("cancel_start")
    task = {"kind": "audio", "videoId": ZOO, "url": watch(ZOO), "outputDir": out, "audioFormat": "m4a",
            "embedThumbnail": False, "embedMetadata": False}
    s = Session(c.args.host, {"AKIF_TEST_START_DELAY_MS": "1500"})
    try:
        s.h.send({"id": "s1", "type": "start", "jobId": "cs1", "task": task})
        s.h.send({"id": "s2", "type": "start", "jobId": "cs1", "task": task})
        s.h.send({"id": "c1", "type": "cancel", "jobId": "cs1"})
        replies, order = {}, []
        deadline = time.time() + 30
        while len(replies) < 3:
            t, m = s._next(deadline - time.time())
            if s._route(t, m):
                order.append(m["event"])
            else:
                replies[m.get("re")] = m
                order.append(m.get("re"))
        s.drain(2.0)
        evs = s.job_events("cs1")
        tree = job_tree(s.h.cmd_pid)
    finally:
        s.close()
    check(replies["s2"].get("ok") is False and replies["s2"].get("code") == "bad_task", f"duplicate start accepted: {replies['s2']}")
    check(replies["c1"].get("ok") is True and "found" not in replies["c1"], f"cancel did not find the starting job: {replies['c1']}")
    check(replies["s1"].get("ok") is True and os.path.normcase(replies["s1"].get("outDir", "")) == os.path.normcase(out), f"start: {replies['s1']}")
    check([e["event"] for e in evs] == ["canceled"], f"events: {evs}")
    check("canceled" not in order[: order.index("s1")], f"canceled arrived before the start's answer: {order}")
    check(not tree, f"a job process was started: {tree}")
    check(not os.listdir(out), f"files: {os.listdir(out)}")
    return {"arrival": order, "events": [e["event"] for e in evs]}


def t_unicode(c):
    out = c.dir("unicode")
    task = {"kind": "audio", "videoId": AZ, "url": watch(AZ), "playlist": False, "outputDir": out, "audioFormat": "m4a",
            "embedThumbnail": False, "embedMetadata": True}
    evs = c.s.run_job("u1", task, 300)
    done = finished_ok(evs)
    title = next(e["title"] for e in evs if e["event"] == "info")
    check("\u015e\u0259ki" in title, f"title {title!r}")
    expected = title.replace("|", "\uff5c") + ".m4a"
    check(os.path.basename(done["filePath"]) == expected, f"{done['filePath']!r} != {expected!r}")
    check(expected in os.listdir(out), os.listdir(out))
    c.files.append(done["filePath"])
    return {"title": title, "file": expected}


def t_playlist(c):
    out = c.dir("playlist")
    task = {"kind": "audio", "videoId": None, "url": f"https://www.youtube.com/playlist?list={PLAYLIST}", "playlist": True,
            "playlistItems": "1:2", "outputDir": out, "audioFormat": "m4a", "embedThumbnail": False, "embedMetadata": False}
    evs = c.s.run_job("p2", task, 600)
    done = finished_ok(evs)
    files = done["files"]
    check(len(files) == 2 and done.get("fileCount") == 2, done)
    names = sorted(os.path.relpath(f["path"], out) for f in files)
    check(names == ["JODA15\\001 - JOD.m4a", "JODA15\\002 - JOD2.m4a"], names)
    for f in files:
        check(os.path.getsize(f["path"]) == f["size"], f)
    prog = progress_checks(c.s, "p2")
    idx = sorted({p.get("playlistIndex") for p in prog})
    cnt = {p.get("playlistCount") for p in prog}
    check(idx == [1, 2] and cnt == {2}, f"playlistIndex {idx} playlistCount {cnt}")
    infos = [e for e in evs if e["event"] == "info"]
    check([(i["playlistIndex"], i["playlistCount"]) for i in infos] == [(1, 2), (2, 2)], infos)
    check(all(i.get("playlistTitle") == "JODA15" for i in infos), infos)
    check(not os.path.exists(os.path.join(out, ".akif-tmp")), "temp dir left behind")
    c.files.extend(f["path"] for f in files)
    return {"files": names, "progressEvents": len(prog), "itemsSeen": idx, "bytes": done["fileSize"]}


def t_open(c):
    d = c.dir("open")
    media = os.path.join(d, "Akif's 50% \u015e\u0259kil [x] (1080p).mp4")
    exe = os.path.join(d, "evil.exe")
    lnk = os.path.join(d, "shortcut.lnk")
    for p in (media, exe, lnk):
        open(p, "wb").close()
    cases = [
        ("media file", {"path": media, "target": "file"}, True, None),
        ("reveal media file", {"path": media, "target": "folder"}, True, None),
        ("open folder", {"path": d, "target": "folder"}, True, None),
        ("exe", {"path": exe, "target": "file"}, False, "bad_path"),
        ("lnk", {"path": lnk, "target": "file"}, False, "bad_path"),
        ("system exe", {"path": "C:\\Windows\\System32\\notepad.exe", "target": "file"}, False, "bad_path"),
        ("ini", {"path": "C:\\Windows\\win.ini", "target": "file"}, False, "bad_path"),
        ("missing", {"path": os.path.join(d, "nope.mp4"), "target": "file"}, False, "not_found"),
        ("relative", {"path": "video.mp4", "target": "file"}, False, "bad_path"),
        ("folder as file", {"path": d, "target": "file"}, False, "bad_path"),
        ("bad target", {"path": media, "target": "run"}, False, "bad_request"),
        ("not a string", {"path": 42, "target": "file"}, False, "bad_path"),
    ]
    bad = []
    for name, params, want_ok, code in cases:
        r = c.s.request("open", **params)
        if want_ok:
            if not (r.get("ok") is True and r.get("dryRun") is True):
                bad.append((name, r))
        elif r.get("ok") is not False or r.get("code") != code:
            bad.append((name, r))
    check(not bad, f"wrong answers: {bad}")
    return {"cases": len(cases)}


def t_pick_update(c):
    r = c.s.request("pickFolder", initial="C:\\")
    check(r.get("ok") is True and r.get("path") is None and r.get("dryRun") is True, r)
    u = c.s.request("updateTools", timeout=120)
    check(u.get("ok") is True and u.get("dryRun") is True and u.get("command"), u)
    if u.get("variant") == "pip":
        check(u["command"][0].lower().endswith("python.exe") and "yt-dlp[default]" in u["command"], u)
    return {"pickFolder": r.get("path"), "updateVariant": u.get("variant"), "updateCommand": " ".join(u["command"]), "before": u.get("before")}


def section_download(s, out, job_id):
    """A long section download (yt-dlp -> python -> ffmpeg) that is still running when this returns.
    15 minutes of 1080p: on a fast connection a 5-minute section was finished before the tree was checked."""
    task = {"kind": "video", "videoId": CAR, "url": watch(CAR), "playlist": False, "outputDir": out, "height": 1080, "width": 1920,
            "hdr": False, "container": "mp4", "section": {"start": 0, "end": 900}}
    s.start(job_id, task)
    wait_bytes(s, job_id, 500_000)
    tree = []
    for _ in range(20):
        tree = job_tree(s.h.cmd_pid)
        if any(exe.lower() == "ffmpeg.exe" for _, exe in tree):
            break
        time.sleep(0.25)
    return tree


def t_eof(c):
    out = c.dir("eof")
    s = Session(c.args.host)
    deno_pid = s.request("hello")["pid"]
    tree = section_download(s, out, "eof1")
    check(any(exe.lower() == "ffmpeg.exe" for _, exe in tree), f"expected ffmpeg in the tree: {tree}")
    t0 = time.perf_counter()
    s.h.close_stdin()
    waited = nmsim.wait_pid(deno_pid, 15)
    check(waited is not None, "host did not exit after stdin EOF")
    code = s.h.wait_cmd(5)
    time.sleep(1.0)
    left, tl = survivors([p for p, _ in tree])
    s.h.close()
    check(not left, f"processes survived EOF: {left} {tl}")
    tmp_gone = not os.path.exists(os.path.join(out, ".akif-tmp"))
    check(tmp_gone, "temp dir not removed on shutdown")
    return {"treeBeforeEof": [f"{exe}:{pid}" for pid, exe in tree], "hostExitMs": round(waited * 1000), "cmdExit": code,
            "survivors": left, "tasklistMatches": tl, "elapsedMs": round((time.perf_counter() - t0) * 1000)}


def t_crash(c):
    out = c.dir("crash")
    s = Session(c.args.host)
    deno_pid = s.request("hello")["pid"]
    tree = section_download(s, out, "crash1")
    nmsim.terminate_pid(deno_pid, 9)  # host killed abruptly: only the Job Objects can clean up
    time.sleep(2.0)
    left, tl = survivors([p for p, _ in tree])
    s.close(5)
    for p in left:
        subprocess.run(["taskkill", "/PID", str(p), "/T", "/F"], capture_output=True)
    check(not left, f"processes survived a host crash: {left} {tl}")
    return {"treeBeforeKill": [f"{exe}:{pid}" for pid, exe in tree], "survivors": left,
            "tempLeft(expected after a crash)": os.path.exists(os.path.join(out, ".akif-tmp"))}


def t_stale_sweep(c):
    """A temp dir left by a crashed host (untouched for 13 h, carrying the host's .akif-job marker) is removed
    when the next job starts in that folder; a recently modified one (maybe another host instance's running
    job) and a folder without the marker (not created by the companion) are kept."""
    out = c.dir("stale")
    tmp = os.path.join(out, ".akif-tmp")
    stale, fresh, foreign = (os.path.join(tmp, n) for n in ("deadbeef", "0badf00d", "feedface"))
    old = time.time() - 13 * 3600
    for d, marker, aged in ((stale, True, True), (fresh, True, False), (foreign, False, True)):
        os.makedirs(d)
        files = [os.path.join(d, "x.mp4.part")] + ([os.path.join(d, ".akif-job")] if marker else [])
        for p in files:
            with open(p, "wb") as f:
                f.write(b"x" * 100)
            if aged:
                os.utime(p, (old, old))
        if aged:
            os.utime(d, (old, old))
    evs = c.s.run_job("st1", {"kind": "audio", "videoId": ZOO, "url": watch(ZOO), "outputDir": out, "audioFormat": "m4a",
                              "embedThumbnail": False, "embedMetadata": False}, 300)
    done = finished_ok(evs)
    c.files.append(done["filePath"])
    check(not os.path.exists(stale), "stale temp dir was not swept")
    check(os.path.exists(fresh), "a recently used temp dir must be kept")
    check(os.path.exists(foreign), "a folder without the .akif-job marker must never be swept")
    shutil.rmtree(tmp, ignore_errors=True)
    return {"staleRemoved": True, "recentKept": True, "unmarkedKept": True}


def watch_tree(s, job_id, out, names, timeout=300):
    """Run until the job ends, polling `out` for files/folders whose lower-case name is in `names`."""
    seen = set()

    def poll(_evs):
        for root, dirs, files in os.walk(out):
            for n in dirs + files:
                if n.lower() in names:
                    seen.add(os.path.relpath(os.path.join(root, n), out))
        return False

    deadline = time.time() + timeout
    while True:
        poll(None)
        evs = s.job_events(job_id)
        if any(e["event"] in TERMINAL for e in evs):
            return evs, sorted(seen)
        check(time.time() < deadline, f"job {job_id}: no terminal event within {timeout} s")
        s.drain(0.05)


def private_jobs_dir(c):
    return os.path.join(os.path.dirname(os.path.dirname(c.args.host)), "state", "jobs")


def t_cookies_private(c):
    """cookies.txt (YouTube session cookies when 'Use my YouTube login' is on) never goes into the output
    folder - it may be synced, shared or on a NAS. It lives in <root>\\state\\jobs\\<pid>-<id> only while
    yt-dlp runs and is gone when the job ends."""
    out = c.dir("cookies")
    cookies = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tAKIF_PROTOCOL_TEST\t1\n"
    c.s.start("ck1", {"kind": "audio", "videoId": ZOO, "url": watch(ZOO), "outputDir": out, "audioFormat": "m4a",
                      "embedThumbnail": False, "embedMetadata": False, "cookies": cookies})
    evs, seen = watch_tree(c.s, "ck1", out, {"cookies.txt"})
    done = finished_ok(evs)
    c.files.append(done["filePath"])
    check(not seen, f"cookies.txt appeared in the output folder: {seen}")
    log = os.path.join(os.path.dirname(os.path.dirname(c.args.host)), "logs", "host.log")
    lines = [ln for ln in open(log, encoding="utf-8", errors="replace").read().splitlines()[-600:] if "job ck1 attempt" in ln]
    check(lines, "no yt-dlp command line for ck1 in the log")
    args = json.loads(lines[-1][lines[-1].index("["):])
    cookie_path = args[args.index("--cookies") + 1]
    check(os.path.normcase(cookie_path).startswith(os.path.normcase(private_jobs_dir(c)) + os.sep), f"--cookies {cookie_path}")
    check(not os.path.exists(cookie_path) and not os.path.exists(os.path.dirname(cookie_path)), "the private job folder was left behind")
    check(not os.path.exists(os.path.join(out, ".akif-tmp")), "temp dir left behind")
    return {"cookiesFile": cookie_path, "seenInOutput": seen}


def t_cloud_private_temp(c):
    """An output folder inside a cloud-sync folder (here: %OneDrive% points at its parent) gets no partial
    files: the job's temp files live in the private folder and only the result is moved in (here through
    the host's own m4a cut, so the host-side move is covered too)."""
    out = c.dir(os.path.join("OneDriveSim", "Videos"))
    s = Session(c.args.host, {"OneDrive": os.path.dirname(out)})
    try:
        s.start("cl1", {"kind": "audio", "videoId": ZOO, "url": watch(ZOO), "outputDir": out, "audioFormat": "m4a",
                        "section": {"start": 3, "end": 9}, "embedThumbnail": False, "embedMetadata": False})
        evs, seen = watch_tree(s, "cl1", out, {".akif-tmp"})
    finally:
        s.close()
    done = finished_ok(evs)
    c.files.append(done["filePath"])
    check(os.path.basename(done["filePath"]) == "Me at the zoo (clip 00-03 - 00-09).m4a", done["filePath"])
    check(not seen, f"partial files were written into the synced folder: {seen}")
    check(os.listdir(out) == [os.path.basename(done["filePath"])], os.listdir(out))
    left = [n for n in (os.listdir(private_jobs_dir(c)) if os.path.isdir(private_jobs_dir(c)) else [])]
    check(not left, f"private job folders left behind: {left}")
    return {"file": os.path.basename(done["filePath"]), "akifTmpSeen": seen}


def t_update_real(c):
    """updateTools for real (test mode off) - only for yt-dlp builds the companion manages itself
    (onedir/exe in bin\\). Never for pip/winget: that would change the user's global installation."""
    s = Session(c.args.host, {"AKIF_HOST_TEST": "0"})
    try:
        variant = s.request("hello")["tools"]["ytdlp"]["variant"]
        if variant not in ("onedir", "exe"):
            raise Skip(f"yt-dlp variant is {variant}; a real update would modify the user's own installation")
        u = s.request("updateTools", timeout=200)
        check(u.get("ok") is True and u.get("after"), u)
        return {"variant": variant, "before": u["before"], "after": u["after"], "updated": u["updated"], "output": u["output"][-300:]}
    finally:
        s.close()


TESTS = [
    ("hello", t_hello), ("ping", t_ping), ("protocol_errors", t_protocol_errors), ("bad_tasks", t_bad_tasks),
    ("video_mp4_240p", t_video_mp4), ("video_section_precise", t_video_section_precise), ("error_unavailable", t_error_unavailable),
    ("retry_transient", t_retry_transient), ("audio_sections_mp3_m4a", t_audio_sections), ("subtitles_srt_txt", t_subtitles),
    ("gif_5s", t_gif), ("cancel_1080p", t_cancel), ("cancel_while_starting", t_cancel_while_starting),
    ("unicode_title", t_unicode), ("playlist_2_items", t_playlist),
    ("open_validation", t_open), ("pickfolder_updatetools_testmode", t_pick_update),
    ("stdin_eof_kills_children", t_eof), ("host_crash_job_objects", t_crash), ("stale_temp_sweep", t_stale_sweep),
    ("cookies_private", t_cookies_private), ("cloud_sync_private_temp", t_cloud_private_temp),
    ("update_tools_real", t_update_real),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=DEFAULT_HOST)
    ap.add_argument("--out", default=os.path.join(HERE, "_downloads"))
    ap.add_argument("--only", default="")
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--results", default="")
    args = ap.parse_args()
    check(os.path.isfile(args.host), f"host not found: {args.host} (run install.bat first)")
    os.makedirs(args.out, exist_ok=True)
    only = {x.strip() for x in args.only.split(",") if x.strip()}
    c = Ctx(args)
    print(f"host: {args.host}\nout:  {args.out}\n", flush=True)
    c.s = Session(args.host)
    results = []
    for name, fn in TESTS:
        if only and name not in only:
            continue
        t0 = time.time()
        status, details, err = "PASS", None, None
        try:
            details = fn(c)
        except Skip as e:
            status, err = "SKIP", str(e)
        except Exception as e:  # noqa: BLE001
            status, err = "FAIL", f"{type(e).__name__}: {e}"
            if not isinstance(e, Fail):
                err += "\n" + traceback.format_exc(limit=3)
        dt = round(time.time() - t0, 1)
        results.append({"test": name, "status": status, "ok": status != "FAIL", "seconds": dt, "details": details, "error": err})
        print(f"{status}  {name}  ({dt}s)", flush=True)
        print("      " + (json.dumps(details, ensure_ascii=False) if status == "PASS" else err).replace("\n", "\n      "), flush=True)
    code = c.s.close()
    passed = sum(r["status"] == "PASS" for r in results)
    skipped = sum(r["status"] == "SKIP" for r in results)
    failed = sum(r["status"] == "FAIL" for r in results)
    print(f"\n{passed} passed, {failed} failed, {skipped} skipped; main host exited with {code} after stdin EOF", flush=True)
    if args.results:
        with open(args.results, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=1)
    if not args.keep:
        for p in c.files:
            try:
                os.remove(p)
            except OSError:
                pass
        shutil.rmtree(args.out, ignore_errors=True)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
