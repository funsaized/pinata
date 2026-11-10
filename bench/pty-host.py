"""Run the explicit Pi command on a fixed-size PTY inside the owning supervisor."""
import errno
import fcntl
import os
import select
import struct
import subprocess
import sys
import termios

master, slave = os.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
try:
    while True:
        readable, _, _ = select.select([master], [], [], 0.1)
        if readable:
            try:
                output = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                break
            if not output:
                break
            sys.stdout.buffer.write(output)
            sys.stdout.buffer.flush()
        elif child.poll() is not None:
            break
finally:
    os.close(master)
sys.exit(child.wait())
