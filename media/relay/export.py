"""Cut the Relay GIF, MP4 and poster from the native window recording."""

import argparse
import subprocess
import tempfile
from pathlib import Path
from typing import NamedTuple


class Shot(NamedTuple):
    start: float
    end: float
    hold: float = 0  # Seconds to keep the last frame on screen for reading.


SOURCE = Path(__file__).with_name("session.mp4")
HERO = [
    Shot(57.50, 68.75),  # Submit the request and watch the two children appear.
    Shot(77.25, 83.75),  # Select the parser and open its branch.
    Shot(106.75, 109.75, 3),  # Read the malformed-line test result.
    Shot(281.50, 287.00),  # Run the CLI and read the report.
]
BUILD = [
    Shot(0.25, 13.75),  # Three Markdown definitions, handoffs and Pi.
    Shot(25.50, 28.75),  # Sample events.
    Shot(38, 48.75),  # Type the request.
    Shot(60.75, 72),  # Submit, open the fleet and watch it branch.
    Shot(76.75, 84.50),  # Select the parser assignment.
    Shot(87.75, 97.25, 3),  # Statistics implementation and nearest-rank test.
    Shot(103, 109.75, 3),  # Switch to the parser and inspect its checks.
    Shot(125.75, 130.25),  # Return to the lead during integration.
    Shot(203.25, 209.25),  # Expand the lead's pinata_children call.
    Shot(219.50, 225.50),  # Read its two worker assignments.
    Shot(250.50, 261),  # Renderer and CLI writes, then the child result.
    Shot(261.75, 270.50),  # Coordinator tests.
    Shot(279.75, 299.25),  # Render the report and verify it against the fixture.
]
POSTER = 78.50


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", *args], check=True)


def cut(source, shots, directory):
    directory.mkdir()
    clips = []
    for index, shot in enumerate(shots):
        clip = directory / f"{index:02d}.mp4"
        filters = ["fps=12", f"trim=duration={shot.end - shot.start}", "setpts=PTS-STARTPTS"]
        if shot.hold:
            filters.append(f"tpad=stop_mode=clone:stop_duration={shot.hold}")
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
