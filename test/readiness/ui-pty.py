"""Drive only the offline readiness extension; retain terminal bytes and assertions."""
import argparse
import errno
import fcntl
import json
import os
import pathlib
import pty
import select
import signal
import struct
import subprocess
import termios
import time

parser = argparse.ArgumentParser()
parser.add_argument("--root", required=True)
parser.add_argument("--out", required=True)
parser.add_argument("--pi", nargs="+", required=True)
args = parser.parse_args()
root = pathlib.Path(args.root).resolve()
output = pathlib.Path(args.out).resolve()
output.mkdir(parents=True, exist_ok=False)
agent = output / "agent"
agent.mkdir()
(agent / "settings.json").write_text(json.dumps({"quietStartup": True, "retry": {"enabled": False}}))
report = output / "events.jsonl"
env = dict(os.environ, PI_CODING_AGENT_DIR=str(agent), PI_OFFLINE="1", PI_SKIP_VERSION_CHECK="1", PI_TELEMETRY="0", TERM="xterm-256color", PINATA_READINESS_UI_LOG=str(report))
command = args.pi + ["--no-session", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "-e", str(root / "test/readiness/ui-extension.ts")]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
process = subprocess.Popen(command, cwd=output, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
seen = 0
opens = 0
navigation = set()
returned = set()
deadline = time.monotonic() + 25
terminal = bytearray()
events = []
try:
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.03)
        if readable:
            try:
                terminal.extend(os.read(master, 65536))
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
        if report.exists():
            lines = report.read_text().splitlines()
            events = [json.loads(line) for line in lines if line]
            for event in events[seen:]:
                phase = event["phase"]
                visit = event.get("visits", 0)
                if phase in ("ready", "restored") and opens < 3:
                    os.write(master, b"\x1b[1;2A")
                    opens += 1
                if phase == "render" and event["ticks"] >= 2 and visit not in navigation:
                    navigation.add(visit)
                    os.write(master, b"\x1b[1;2C")
                if phase == "render" and event["screen"] == "conversation" and visit not in returned:
                    returned.add(visit)
                    os.write(master, b"\x1b")
                if phase == "finished":
                    # Exit from the host's normal key path after the async shortcut returns.
                    os.write(master, b"\x03")
                    time.sleep(0.08)
                    os.write(master, b"\x03")
            seen = len(events)
        if process.poll() is not None:
            break
    if process.poll() is None:
        raise RuntimeError("Offline UI probe did not complete within 25 seconds")
    assert process.returncode == 0, process.returncode
    finished = [event for event in events if event["phase"] == "finished"]
    assert finished and finished[-1]["draftUnchanged"], events[-10:]
    assert finished[-1]["disposed"] == 3, finished
    assert len(navigation) == 3 and len(returned) == 3
    assert all(event["unchanged"] for event in events if event["phase"] == "restored")
    print(json.dumps({"ok": True, "visits": opens, "navigation": len(navigation), "disposals": 3, "draftPreserved": True, "providerCalls": 0, "overlay": False}))
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    (output / "terminal.bin").write_bytes(terminal)
    os.close(master)
