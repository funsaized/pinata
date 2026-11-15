"""Record a scripted fleet in a real Pi PTY and rasterize its returned terminal rows.

Requires ffmpeg, Pillow, fontconfig and Adwaita Mono. Run with --root, --out (new directory), and --pi.
No credentials or model calls are used. Raw PTY bytes and event timing are retained.
"""
import argparse
import errno
import fcntl
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
import unicodedata
from PIL import Image, ImageDraw, ImageFont

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--root", required=True)
parser.add_argument("--out", required=True)
parser.add_argument("--pi", nargs="+", required=True)
args = parser.parse_args()
root = pathlib.Path(args.root).resolve()
output = pathlib.Path(args.out).resolve()
output.mkdir(parents=True, exist_ok=False)
agent = output / "agent"
agent.mkdir()
(agent / "settings.json").write_text(json.dumps({"quietStartup": True, "theme": "dark", "retry": {"enabled": False}}))
report = output / "events.jsonl"
env = dict(os.environ, PI_CODING_AGENT_DIR=str(agent), PI_OFFLINE="1", PI_SKIP_VERSION_CHECK="1", PI_TELEMETRY="0", TERM="xterm-256color", COLORTERM="truecolor", PINATA_DEMO_LOG=str(report))
env.pop("NO_COLOR", None)
command = args.pi + ["--no-session", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "-e", str(root / "test/readiness/fleet-demo.ts")]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 38, 160, 0, 0))
process = subprocess.Popen(command, cwd=output, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
terminal = bytearray()
start = None
sent = 0
opened = False
# Timed user input, including run switching, conversation, filters and inspector focus.
steps = [(3, b"\x1b[B"), (5, b"\x1b[B"), (7, b"\t"), (9, b"\td"),
         (11, b"d\r"), (14, b"\x1b[1;2A"), (16, b"w"), (19, b"w"),
         (21, b"h"), (24, b"h"), (26, b"r"), (29, b"\x1b[B\r"),
         (32, b"h"), (35, b"r"), (37, b"\x1b[A\r"), (40, b"\x1b[1;2A"),
         (41, b"\x03"), (41.2, b"\x03")]
try:
    deadline = time.monotonic() + 60
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
            if not opened and any(event["phase"] == "ready" for event in events):
                os.write(master, b"\x1b[24~")
                opened = True
            if start is None and any(event["phase"] == "frame" for event in events):
                start = time.monotonic()
            if start is not None and sent < len(steps) and time.monotonic() - start >= steps[sent][0]:
                os.write(master, steps[sent][1])
                sent += 1
        if process.poll() is not None:
            break
    if process.poll() is None:
        raise RuntimeError("Fleet recording timed out")
    assert process.returncode == 0, process.returncode
    assert not any(event["phase"] == "provider-request" for event in events)
    frames = [event for event in events if event["phase"] == "frame"]
    assert len(frames) > 50
    plain = "\n".join(re.sub(r"\x1b\[[0-9;]*m", "", line) for frame in frames for line in frame["output"])
    for label in ["Prompt", "Last message", "Project runs", "previous-demo", "following latest", "Waiting for"]:
        assert label in plain, f"Missing demo view: {label}"
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    (output / "terminal.bin").write_bytes(terminal)
    os.close(master)

# Rasterize the exact rows supplied to Pi's terminal. This is not a model-generated image.
font_path = subprocess.check_output(["fc-list", "Adwaita Mono:style=Regular", "-f", "%{file}"], text=True).strip()
if not font_path:
    raise RuntimeError("Install Adwaita Mono for reproducible terminal glyphs")
font = ImageFont.truetype(font_path, 16)
bold_path = subprocess.check_output(["fc-list", "Adwaita Mono:style=Bold", "-f", "%{file}"], text=True).strip()
bold_font = ImageFont.truetype(bold_path, 16)
cell, line_height, margin = 10, 23, 20
foreground, background = "#ededf0", "#171823"

def indexed_color(index):
    basic = ["#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0", "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"]
    if index < 16:
        return basic[index]
    if index >= 232:
        return "#" + format(8 + 10 * (index - 232), "02x") * 3
    index -= 16
    levels = [0, 95, 135, 175, 215, 255]
    return "#" + "".join(format(levels[c], "02x") for c in [index // 36, (index // 6) % 6, index % 6])

def raster(frame, path):
    image = Image.new("RGB", (1640, 914), background)
    draw = ImageDraw.Draw(image)
    for row, text in enumerate(frame["output"]):
        text = re.sub(r"\x1b_[^\x07]*\x07", "", text)
        fg, bg, bold, reverse = foreground, background, False, False
        column = 0
        for part in re.split(r"(\x1b\[[0-9;]*m)", text):
            if part.startswith("\x1b["):
                codes = [int(code or 0) for code in part[2:-1].split(";")]
                offset = 0
                while offset < len(codes):
                    code = codes[offset]
                    if code == 0:
                        fg, bg, bold, reverse = foreground, background, False, False
                    elif code == 1: bold = True
                    elif code == 22: bold = False
                    elif code == 7: reverse = True
                    elif code == 27: reverse = False
                    elif code == 39: fg = foreground
                    elif code == 49: bg = background
                    elif 30 <= code <= 37: fg = indexed_color(code - 30)
                    elif 40 <= code <= 47: bg = indexed_color(code - 40)
                    elif code in (38, 48):
                        if codes[offset + 1] == 5:
                            color = indexed_color(codes[offset + 2])
                            offset += 2
                        else:
                            color = "#" + "".join(format(c, "02x") for c in codes[offset + 2:offset + 5])
                            offset += 4
                        if code == 38: fg = color
                        else: bg = color
                    offset += 1
                continue
            for character in part:
                if ord(character) < 32: continue
                cells = 2 if unicodedata.east_asian_width(character) in ("W", "F") else 1
                x, y = margin + column * cell, margin + row * line_height
                ink, fill = (bg, fg) if reverse else (fg, bg)
                draw.rectangle((x, y, x + cells * cell - 1, y + line_height - 1), fill=fill)
                draw.text((x, y + 1), character, font=bold_font if bold else font, fill=ink)
                column += cells
    image.save(path)

images = output / "frames"
images.mkdir()
frame_index = 0
fps, duration = 4, 40
for index in range(fps * duration):
    timestamp = frames[0]["at"] + 1000 * index / fps
    while frame_index + 1 < len(frames) and frames[frame_index + 1]["at"] <= timestamp:
        frame_index += 1
    raster(frames[frame_index], images / f"{index:04d}.png")
raster(next(frame for frame in frames if frame["at"] - frames[0]["at"] >= 1500), output / "pinata-fleet.png")
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(fps), "-i", str(images / "%04d.png"), "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output / "pinata-demo.mp4")], check=True)
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(output / "pinata-demo.mp4"), "-filter_complex", "fps=4,scale=1230:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse=dither=bayer", "-loop", "0", str(output / "pinata-navigation.gif")], check=True)
print(json.dumps({"frames": len(frames), "seconds": duration, "providerCalls": 0, "terminalBytes": len(terminal), "output": str(output)}))
