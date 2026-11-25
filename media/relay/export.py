"""Rebuild the Relay cuts from the recorded terminal output, without starting Pi."""

import argparse
import gzip
import subprocess
import tempfile
from pathlib import Path
from typing import NamedTuple

from PIL import Image, ImageDraw, ImageFont


class Shot(NamedTuple):
    start: float
    end: float
    view: str
    crop: tuple[int, int] | None = None


# Source seconds, view, and (for the hero) the vertical bounds of the close-up.
HERO = [
    Shot(73.0, 77.875, "Pi composer", (530, 668)),
    Shot(77.875, 79.875, "Coordinator", (490, 570)),
    Shot(93.875, 96.875, "Fleet", (0, 316)),
    Shot(104.0, 110.5, "Fleet", (0, 316)),
    Shot(203.25, 209.5, "event-parser", (0, 423)),
    Shot(272.5, 278.75, "Coordinator", (204, 566)),
]
BUILD = [
    Shot(42.0, 51.0, "Project agents"),
    Shot(55.0, 69.0, "Pi composer"),
    Shot(76.0, 81.0, "Pi composer"),
    Shot(84.5, 89.0, "Fleet"),
    Shot(94.0, 97.0, "Fleet"),
    Shot(97.0, 103.25, "relay-lead"),
    Shot(103.25, 111.75, "Fleet"),
    Shot(130.5, 139.5, "event-parser"),
    Shot(139.5, 144.5, "incident-stats"),
    Shot(167.75, 189.5, "incident-stats"),
    Shot(198.0, 210.5, "event-parser"),
    Shot(235.875, 242.5, "relay-lead"),
    Shot(246.875, 253.0, "relay-lead"),
    Shot(261.5, 293.0, "Coordinator"),
]
FPS = 8


def frames_at_times(source, times):
    """Composite the variable-delay source GIF in order, including skipped frames."""
    with Image.open(source) as screen:
        end = screen.info["duration"]
        for seconds in times:
            while end <= seconds * 1000:
                screen.seek(screen.tell() + 1)
                end += screen.info["duration"]
            yield screen


def encode(source, shots, output, font, hero=False):
    times = [
        (shot, shot.start + tick / FPS)
        for shot in shots
        for tick in range(round((shot.end - shot.start) * FPS))
    ]
    gaps = {current: current.start - previous.end for previous, current in zip(shots, shots[1:])}
    with Image.open(source) as screen:
        width = screen.width
        viewport = 438 if hero else screen.height
    size = (width, viewport + 46)
    command = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
               "-s", f"{size[0]}x{size[1]}", "-r", str(FPS), "-i", "pipe:0", "-an"]
    if hero:
        command += ["-filter_complex", "split[a][b];[a]palettegen[p];[b][p]paletteuse=dither=bayer",
                    "-loop", "0"]
    else:
        command += ["-c:v", "libx264", "-threads", "4", "-crf", "16", "-pix_fmt", "yuv420p",
                    "-movflags", "+faststart"]

    with subprocess.Popen([*command, str(output)], stdin=subprocess.PIPE) as encoder:
        try:
            frames = frames_at_times(source, (seconds for _, seconds in times))
            for (shot, seconds), screen in zip(times, frames, strict=True):
                picture = screen.convert("RGB")
                canvas = Image.new("RGB", size, picture.getpixel((0, 0)))
                if shot.crop:
                    top, bottom = shot.crop
                    picture = picture.crop((0, top, width, bottom))
                canvas.paste(picture, (0, (viewport - picture.height) // 2))
                draw = ImageDraw.Draw(canvas)
                draw.rectangle((0, viewport, width, size[1]), fill="#101318")
                draw.line((0, viewport, width, viewport), fill="#343a42")
                draw.text((20, viewport + 23), shot.view, font=font, fill="#c9d1d9", anchor="lm")
                stamp = f"Session {int(seconds) // 60:02d}:{int(seconds) % 60:02d}"
                skipped = gaps.get(shot, 0)
                if skipped and seconds - shot.start < 3:
                    stamp = f"{skipped:.0f}s skipped  ·  {stamp}"
                draw.text((width - 20, viewport + 23), stamp, font=font, fill="#aab5c2", anchor="rm")
                encoder.stdin.write(canvas.tobytes())
        finally:
            encoder.stdin.close()
        if encoder.wait():
            raise RuntimeError(f"FFmpeg could not write {output}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="new directory for the three assets")
    args = parser.parse_args()
    if args.output.exists():
        parser.error(f"Choose a new output directory: {args.output}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=args.output.parent) as directory:
        exports = Path(directory) / "exports"
        exports.mkdir()
        cast = Path(directory) / "session.cast"
        cast.write_bytes(gzip.decompress(Path(__file__).with_name("session.cast.gz").read_bytes()))
        source = Path(directory) / "source.gif"
        subprocess.run(["agg", "-q", "--text-font-family", "Adwaita Mono", "--font-size", "22",
                        "--line-height", "1.24", "--theme", "github-dark", "--idle-time-limit", "600",
                        "--fps-cap", "12", str(cast), str(source)], check=True)
        font_paths = subprocess.check_output(
            ["fc-list", "Adwaita Mono:style=Regular", "-f", "%{file}\n"], text=True
        ).splitlines()
        if not font_paths:
            raise RuntimeError("Install Adwaita Mono before rendering the recording")
        font = ImageFont.truetype(font_paths[0], 19)
        encode(source, HERO, exports / "pinata-navigation.gif", font, hero=True)
        encode(source, BUILD, exports / "pinata-demo.mp4", font)
        for screen in frames_at_times(source, [110]):
            poster = screen.convert("RGB").crop((0, 0, screen.width, 610))
            poster.save(exports / "pinata-fleet.png")
        exports.rename(args.output)


if __name__ == "__main__":
    main()
