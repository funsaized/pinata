"""Capture the replacement UI in an isolated offline Pi PTY; never call a model."""
import argparse
import errno
import fcntl
import html
import json
import os
import pathlib
import pty
import re
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
env = dict(os.environ, PI_CODING_AGENT_DIR=str(agent), PI_OFFLINE="1", PI_SKIP_VERSION_CHECK="1", PI_TELEMETRY="0", TERM="xterm-256color", PINATA_REWRITE_UI_LOG=str(report))
env.pop("NO_COLOR", None)
command = args.pi + ["--no-session", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "-e", str(root / "test/readiness/rewrite-ui-extension.ts")]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
process = subprocess.Popen(command, cwd=output, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
terminal = bytearray()
events = []
seen = 0
opens = 0
stages = {}
frames = []
deadline = time.monotonic() + 30


def send(data):
    os.write(master, data)


def plain(value):
    return re.sub(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b_[^\x07]*\x07", "", value)


def color(index):
    basic = ["#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0", "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"]
    if index < 16:
        return basic[index]
    if index >= 232:
        return "#" + format(8 + 10 * (index - 232), "02x") * 3
    index -= 16
    levels = [0, 95, 135, 175, 215, 255]
    return "#" + "".join(format(levels[channel], "02x") for channel in [index // 36, (index // 6) % 6, index % 6])


def styled(value, foreground, background):
    fg, bg = foreground, background
    weight = "normal"
    spans = []
    for part in re.split(r"(\x1b\[[0-9;]*m)", value):
        if part.startswith("\x1b[") and part.endswith("m"):
            codes = [int(code or 0) for code in part[2:-1].split(";")]
            offset = 0
            while offset < len(codes):
                code = codes[offset]
                if code == 0:
                    fg, bg = foreground, background
                    weight = "normal"
                elif code == 1:
                    weight = "bold"
                elif code == 22:
                    weight = "normal"
                elif code == 39:
                    fg = foreground
                elif code == 49:
                    bg = background
                elif code in (38, 48) and offset + 2 < len(codes):
                    if codes[offset + 1] == 5:
                        selected = color(codes[offset + 2])
                        offset += 2
                    elif codes[offset + 1] == 2 and offset + 4 < len(codes):
                        selected = "#" + "".join(format(v, "02x") for v in codes[offset + 2:offset + 5])
                        offset += 4
                    else:
                        offset += 1
                        continue
                    if code == 38:
                        fg = selected
                    else:
                        bg = selected
                offset += 1
        else:
            spans.append(f'<span style="color:{fg};background:{bg};font-weight:{weight}">' + html.escape(plain(part)) + "</span>")
    return "".join(spans)


try:
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.02)
        if readable:
            try:
                terminal.extend(os.read(master, 65536))
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
        if report.exists():
            events = [json.loads(line) for line in report.read_text().splitlines() if line]
            for event in events[seen:]:
                phase = event["phase"]
                visit = event.get("visits", 0)
                if phase in ("ready", "restored") and opens < 3:
                    opens += 1
                    width = [120, 60, 30][opens - 1]
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, width, 0, 0))
                    os.kill(process.pid, signal.SIGWINCH)
                    send(b"\x1b[24~")
                if phase == "render" and event["ticks"] >= 2:
                    stage = stages.get(visit, 0)
                    screen = event["screen"]
                    worker = (event.get("selected") or {}).get("worker")
                    draft = event["draft"]
                    if stage == 0 and screen == "fleet":
                        frames.append(event)
                        stages[visit] = 1
                        send(b"\r")
                    elif stage == 1 and screen == "conversation" and not event["loading"]:
                        frames.append(event)
                        stages[visit] = 2
                        if visit == 1:
                            send(b"\td\t")
                            send(b"\x1b[<65;10;20M")
                            send(b"worker-one draft")
                        else:
                            send(b"\x1b[1;2B")
                    elif stage == 2 and visit == 1 and draft == "worker-one draft":
                        stages[visit] = 3
                        send(b"\x1b[1;2C")
                    elif stage == 3 and worker == "worker-2":
                        stages[visit] = 4
                        send(b"worker-two draft")
                    elif stage == 4 and draft == "worker-two draft":
                        stages[visit] = 5
                        send(b"\x1b[1;2D")
                    elif stage == 5 and worker == "worker-1" and draft == "worker-one draft":
                        frames.append(event)
                        stages[visit] = 6
                        send(b"\x1b[1;2A")
                    elif screen == "fleet" and ((visit == 1 and stage == 6) or (visit > 1 and stage == 2)):
                        stages[visit] = 7
                        send(b"\x1b[1;2B")
                if phase == "finished":
                    send(b"\x03")
                    time.sleep(0.08)
                    send(b"\x03")
            seen = len(events)
        if process.poll() is not None:
            break
    if process.poll() is None:
        raise RuntimeError("Replacement UI capture timed out after 30 seconds")
    assert process.returncode == 0, process.returncode
    finished = [event for event in events if event["phase"] == "finished"]
    assert finished and finished[-1]["parentUnchanged"] and finished[-1]["workerDrafts"], events[-10:]
    assert finished[-1]["disposals"] == 3
    assert not [event for event in events if event["phase"] in ("provider-request", "error")]
    assert all(event["overlay"] for event in events if event["phase"] == "custom")
    assert all(event["parentUnchanged"] for event in events if event["phase"] == "restored")
    assert all(stage == 7 for stage in stages.values())
    assert any(event.get("scroll", 0) > 0 for event in events if event["phase"] == "render"), "Mouse wheel did not scroll the worker conversation"
    assert all(len(event["output"]) == 40 for event in events if event["phase"] == "render"), "Panel must fill the viewport"
    text = "\n".join(plain(line) for frame in frames for line in frame["output"])
    assert "Pinata" in text and "Full retained conversation line 100" in text
    assert "following latest" in text
    print(json.dumps({"ok": True, "visits": opens, "disposals": 3, "parentDraftPreserved": True, "workerDraftsPreserved": True, "providerCalls": 0, "overlay": True, "widths": [120, 60, 30], "palettes": ["pinata", "one-light", "terminal-default"], "terminalBytes": len(terminal)}))
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    (output / "terminal.bin").write_bytes(terminal)
    (output / "frames.json").write_text(json.dumps(frames, indent=2))
    document = ["<!doctype html><meta charset=utf-8><title>Pinata offline terminal capture</title><style>body{background:#151321;color:#f3edf9;font:16px system-ui;margin:32px}pre{font:14px/1.5 monospace;background:#211e30;padding:20px;overflow:auto;border-radius:8px}h2{font-size:18px}</style><h1>Pinata offline terminal capture</h1><p>Frames below were returned to a real Pi terminal. Raw PTY bytes are retained separately in terminal.bin. No model requests were made.</p>"]
    for frame in frames:
        foreground, background = ("#383a42", "#fafafa") if frame["visits"] == 2 else ("#f3edf9", "#151321")
        document.append(f"<h2>Visit {frame['visits']} · {frame['screen']} · {frame['width']} columns</h2><pre style='color:{foreground};background:{background}'>" + "\n".join(styled(line, foreground, background) for line in frame["output"]) + "</pre>")
    (output / "frames.html").write_text("\n".join(document))
    os.close(master)
