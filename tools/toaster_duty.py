#!/usr/bin/env python3
"""toaster_duty.py — slow EVERY thread of Chrome's renderer processes by a factor R.

Used by tools/toaster_bench.mjs. WHY NOT CDP: Chrome 141's
Emulation.setCPUThrottlingRate answers "Operation is only supported for pages,
not workers" on every worker/service-worker target, and a page-level throttle
measured 0.90x / 1.05x on a dedicated / nested worker (BenchmarkIndex, rate 3)
— i.e. it does not reach the threads the emulators run on.

Mechanism: a duty cycle of SIGSTOP/SIGCONT on each renderer process (page main
thread, dedicated + nested workers, service workers, audio worklet all live
there): every PERIOD it runs for PERIOD/R and is stopped for the rest. Each
thread's throughput becomes 1/R of what it was. The cycler runs SCHED_FIFO so
its timing does not depend on the load it is imposing.

THE GPU PROCESS IS THROTTLED TOO (default since 2026-10-15, gpu=1). On a device
with no GPU the picture is rasterised by a software renderer on the same slow
CPU: Chrome's GPU process runs SwiftShader there, on the host's cores. Leaving it
at full speed (CDP's semantics, and this tool's before that date) let the
rasterizer use ~56% of the box while the emulation worker was slowed 6.2x, so the
gate under-counted every rendering cost. With gpu=1 every --type=gpu-process is
stopped and continued IN THE SAME CYCLE as the renderers, at the same rate.
gpu=0 is the old arm (renderers only), kept as the control. The browser process
is never touched. tools/toaster_bench.mjs proves the GPU arm with a raster
benchmark (raster slowdown must reach the rate with gpu=1 and must differ from
the gpu=0 arm, or the proof fails).

  python3 tools/toaster_duty.py <browser_pid> <rate> [period_ms=4] [status_file] [gpu=1|0]
  (TOASTER_GPU=0 in the environment sets the default to 0)

Exits when the browser pid is gone; always SIGCONTs everything it stopped.
"""
import os, sys, time, signal

bpid = int(sys.argv[1]); rate = float(sys.argv[2])
period = float(sys.argv[3]) / 1000 if len(sys.argv) > 3 else 0.004
status = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] not in ('', '-') else None
gpu = (sys.argv[5] if len(sys.argv) > 5 else os.environ.get('TOASTER_GPU', '1')) not in ('0', 'gpu=0', 'off')
TYPES = (b'--type=renderer', b'--type=gpu-process') if gpu else (b'--type=renderer',)
on = period / rate; off = period - on
try: os.sched_setscheduler(0, os.SCHED_FIFO, os.sched_param(10))
except Exception: pass

def children():
    kids = {}
    for d in os.listdir('/proc'):
        if not d.isdigit(): continue
        try:
            with open(f'/proc/{d}/stat') as f: st = f.read()
            ppid = int(st[st.rfind(')') + 2:].split()[1])
            kids.setdefault(ppid, []).append(int(d))
        except Exception: pass
    out, todo = [], [bpid]
    gpus.clear()
    while todo:
        p = todo.pop()
        for c in kids.get(p, []):
            todo.append(c)
            try:
                with open(f'/proc/{c}/cmdline', 'rb') as f: cl = f.read()
                if any(t in cl for t in TYPES):
                    out.append(c)
                    if b'--type=gpu-process' in cl: gpus.add(c)
            except Exception: pass
    return out

pids, last_scan, seen, gpus = [], 0.0, set(), set()
def cont_all():
    for p in pids:
        try: os.kill(p, signal.SIGCONT)
        except Exception: pass
def bye(*_):
    cont_all(); sys.exit(0)
signal.signal(signal.SIGTERM, bye); signal.signal(signal.SIGINT, bye)

cycles = 0
try:
    while True:
        now = time.monotonic()
        if now - last_scan > 0.2:
            if not os.path.exists(f'/proc/{bpid}'): break
            pids = children(); last_scan = now; seen.update(pids)
            if status:
                try:
                    with open(status, 'w') as f: f.write(f'{{"rate":{rate},"periodMs":{period*1000},"gpu":{1 if gpu else 0},"targets":{len(pids)},"gpuProcs":{len(gpus)},"renderers":{len(pids)-len(gpus)},"everSeen":{len(seen)},"cycles":{cycles}}}')
                except Exception: pass
        if rate <= 1.0:
            time.sleep(0.2); continue
        time.sleep(on)
        for p in pids:
            try: os.kill(p, signal.SIGSTOP)
            except Exception: pass
        time.sleep(off)
        for p in pids:
            try: os.kill(p, signal.SIGCONT)
            except Exception: pass
        cycles += 1
finally:
    cont_all()
