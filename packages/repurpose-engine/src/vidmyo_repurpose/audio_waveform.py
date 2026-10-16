"""Bounded-memory source audio peaks for local review, not editorial decisions."""
import hashlib
import json
import math
import os
import struct
import subprocess
import threading
from pathlib import Path

def pcm_peaks(chunks, duration, bins=800, rate=8000):
    if not math.isfinite(duration) or duration <= 0 or not 16 <= bins <= 2000:
        raise ValueError('Invalid waveform dimensions')
    peaks = [0.0] * bins
    expected = max(1, round(duration * rate))
    offset = 0
    carry = b''
    for chunk in chunks:
        data = carry + chunk
        carry = data[len(data) // 2 * 2:]
        for (value,) in struct.iter_unpack('<h', data[:len(data) // 2 * 2]):
            index = min(bins - 1, offset * bins // expected)
            peaks[index] = max(peaks[index], abs(value) / 32768)
            offset += 1
    if not offset:
        raise ValueError('No audio samples available')
    return {'version': 1, 'duration_seconds': duration, 'peaks': [round(p, 4) for p in peaks]}

def source_waveform(project_dir: Path):
    manifest = json.loads((project_dir / 'cleaner.json').read_text())
    source = Path(manifest['source']['uri']).expanduser().resolve()
    ingest = json.loads((project_dir / 'artifacts' / 'ingest-artifact.v1.json').read_text())
    duration = float(ingest['container']['duration_seconds'])
    stat = source.stat()
    identity = hashlib.sha256(json.dumps([str(source), stat.st_size, stat.st_mtime_ns, duration, 'peaks-v1']).encode()).hexdigest()[:24]
    cache = project_dir / 'artifacts' / f'cleaner-waveform-{identity}.json'
    if cache.is_file():
        return json.loads(cache.read_text())
    process = subprocess.Popen(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', str(source),
        '-map', '0:a:0', '-vn', '-ac', '1', '-af', 'aresample=8000:async=1:first_pts=0', '-ar', '8000', '-f', 's16le', 'pipe:1'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    expired = threading.Event()
    def timeout():
        expired.set()
        process.kill()
    timer = threading.Timer(180, timeout)
    timer.daemon = True
    timer.start()
    try:
        result = pcm_peaks(iter(lambda: process.stdout.read(65536), b''), duration)
        if process.wait() or expired.is_set():
            raise ValueError('Audio waveform extraction failed or timed out')
    finally:
        timer.cancel()
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdout.close()
    temporary = cache.with_name(f'.{cache.name}.{os.getpid()}.tmp')
    try:
        temporary.write_text(json.dumps(result))
        os.replace(temporary, cache)
    finally:
        temporary.unlink(missing_ok=True)
    return result
