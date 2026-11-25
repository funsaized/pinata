"""Cut the Relay GIF, MP4 and poster from the native window recording."""

import argparse
import subprocess
import tempfile
from pathlib import Path
from typing import NamedTuple


class Shot(NamedTuple):
    start: float
    end: float


SOURCE = Path(__file__).with_name("session.mp4")
HERO = [
    Shot(42.50, 58.75),  # Submit, watch the fleet branch and open the parser.
    Shot(115.75, 122.25),  # Check recovery from a malformed event.
    Shot(238.25, 245.00),  # Run the CLI and read the report.
]
BUILD = [
    Shot(0.25, 33.00),  # Definitions, handoffs, host grant and prompt.
    Shot(45.00, 65.50),  # Submit, open the fleet and visit both children.
    Shot(73.25, 77.00),  # Statistics implementation.
    Shot(85.50, 96.50),  # Statistics tests and checks.
    Shot(102.50, 105.50),  # Return to the parser.
    Shot(112.50, 122.00),  # Inspect the corrected edit and malformed-line test.
    Shot(136.50, 144.75),  # The lead tests and runs the assembled CLI.
    Shot(168.00, 178.50),  # Expand its call and read both assignments.
    Shot(213.25, 255.25),  # Renderer, CLI, child results and coordinator verification.
]
POSTER = 55.00


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", *args], check=True)


def cut(source, shots, directory):
    directory.mkdir()
    clips = []
    for index, shot in enumerate(shots):
        clip = directory / f"{index:02d}.mp4"
        filters = ["fps=12", f"trim=duration={shot.end - shot.start}", "setpts=PTS-STARTPTS"]
        ffmpeg("-ss", str(shot.start), "-i", str(source), "-vf", ",".join(filters),
               "-an", "-c:v", "libx264", "-threads", "4", "-crf", "15",
               "-preset", "fast", "-pix_fmt", "yuv420p", str(clip))
        clips.append(f"file '{clip.name}'\n")

    playlist = directory / "clips.ffconcat"
    playlist.write_text("ffconcat version 1.0\n" + "".join(clips), encoding="utf-8")
    return ["-f", "concat", "-i", str(playlist)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="new directory for the three exports")
    args = parser.parse_args()
    if args.output.exists():
        parser.error(f"Choose a new output directory: {args.output}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=args.output.parent) as temp:
        work = Path(temp)
        exports = work / "exports"
        exports.mkdir()
        build = cut(SOURCE, BUILD, work / "build")
        ffmpeg(*build, "-c", "copy", "-movflags", "+faststart", str(exports / "pinata-demo.mp4"))
        hero = cut(SOURCE, HERO, work / "hero")
        palette = work / "palette.png"
        ffmpeg(*hero, "-vf", "fps=8,palettegen", "-frames:v", "1", str(palette))
        ffmpeg(*hero, "-i", str(palette), "-filter_complex",
               "[0:v]fps=8[v];[v][1:v]paletteuse=dither=none:diff_mode=rectangle",
               "-loop", "0", str(exports / "pinata-navigation.gif"))
        ffmpeg("-ss", str(POSTER), "-i", str(SOURCE), "-frames:v", "1", str(exports / "pinata-fleet.png"))
        exports.rename(args.output)


if __name__ == "__main__":
    main()
