#!/usr/bin/env python3
"""Run a command in a real pseudo-terminal, feed scripted keys, capture raw output.

usage: pty-run.py COLS ROWS STEPS -- CMD...
  STEPS: comma separated: "wait:<ms>", "key:<text>" (\\r, \\x1b, \\x1b[B escapes allowed),
         "resize:<cols>x<rows>", "until:<text>" (wait up to 20 s for text in output),
         "snap" (print "SNAP <byte offset>" to stderr – replay up to there with screen.py --at)
Raw output goes to stdout; exit code = the command's exit code. POSIX only (e2e tests, captures).
"""
import fcntl, os, pty, select, signal, struct, sys, termios, time


def main():
    cols, rows, steps = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
    cmd = sys.argv[sys.argv.index('--') + 1:]
    pid, fd = pty.fork()
    if pid == 0:
        os.environ['COLUMNS'] = str(cols)
        os.environ['LINES'] = str(rows)
        os.execvp(cmd[0], cmd)
    def setsize(c, r):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
    setsize(cols, rows)
    out = bytearray()

    def pump(timeout):
        end = time.time() + timeout
        while True:
            left = end - time.time()
            if left <= 0:
                return True
            r, _, _ = select.select([fd], [], [], left)
            if not r:
                continue
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            out.extend(data)

    alive = True
    for step in [s for s in steps.split(',') if s]:
        kind, _, arg = step.partition(':')
        if kind == 'wait':
            alive = pump(int(arg) / 1000) and alive
        elif kind == 'key':
            os.write(fd, arg.encode().decode('unicode_escape').encode('utf-8'))
            alive = pump(0.05) and alive
        elif kind == 'resize':
            c, r = arg.split('x')
            setsize(int(c), int(r))
            os.kill(pid, signal.SIGWINCH)
            alive = pump(0.2) and alive
        elif kind == 'snap':
            sys.stderr.write('SNAP %d\n' % len(out))
        elif kind == 'until':
            t0 = time.time()
            while arg.encode() not in out and time.time() - t0 < 20:
                if not pump(0.05):
                    break
    # drain until exit
    t0 = time.time()
    while time.time() - t0 < 10:
        if not pump(0.1):
            break
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            pump(0.1)
            break
    else:
        os.kill(pid, signal.SIGKILL)
    try:
        _, status = os.waitpid(pid, 0)
    except ChildProcessError:
        status = 0
    sys.stdout.buffer.write(bytes(out))
    sys.stdout.flush()
    code = os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else (status >> 8)
    sys.exit(code if code >= 0 else 128 - code)


if __name__ == '__main__':
    main()
