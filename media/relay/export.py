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
    Shot(80, 85.75),       # Prompt and submission
    Shot(95.75, 101.50),   # Lead and both live children
    Shot(112.50, 117.75),  # Parser assignment
    Shot(133.75, 135.75, 3.50),
    Shot(319.75, 326.50),  # CLI report
]
BUILD = [
    Shot(0, 17.75),        # Project definitions, handoffs and launch
    Shot(60.75, 64.75),    # Sample input
    Shot(70.50, 76.75),    # Type the request
    Shot(82.50, 103.50),   # Submit and open the fleet
    Shot(111.75, 135.75, 3.50),  # Assignments, stats branch and parser checks
    Shot(151.00, 156.25),  # Return to the lead
    Shot(252.75, 261.00),  # Inspect its pinata_children call
    Shot(276.75, 283.50),  # Renderer and CLI writes
    Shot(287.25, 300.00),  # Child results and integration checks
    Shot(311.75, 327.00),  # Coordinator tests and CLI report
    Shot(336.00, 344.50),  # Independent verification
]


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", *args], check=True)


def cut(source, shots, directory):
    directory.mkdir()
    clips = []
    previous = None
    for index, shot in enumerate(shots):
        clip = directory / f"{index:02d}.mp4"
        filters = ["fps=12", f"trim=duration={shot.end - shot.start}", "setpts=PTS-STARTPTS"]
        if shot.hold:
            filters.append(f"tpad=stop_mode=clone:stop_duration={shot.hold}")
        if previous is not None:
            gap = round(shot.start - previous.end)
            filters.append(
                f"drawtext=font='DejaVu Sans':text='{gap}s later':fontsize=20:"
                "x=38:y=h-90:fontcolor=white:box=1:boxcolor=black@0.80:"
                "boxborderw=6:enable='lt(t,2.5)'"
            )
        ffmpeg("-ss", str(shot.start), "-i", str(source), "-vf", ",".join(filters),
               "-an", "-c:v", "libx264", "-threads", "4", "-crf", "15",
               "-preset", "fast", "-pix_fmt", "yuv420p", str(clip))
        clips.append(f"file '{clip.name}'\n")
        previous = shot

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
        ffmpeg("-ss", "114", "-i", str(SOURCE), "-frames:v", "1", str(exports / "pinata-fleet.png"))
        exports.rename(args.output)


if __name__ == "__main__":
    main()
