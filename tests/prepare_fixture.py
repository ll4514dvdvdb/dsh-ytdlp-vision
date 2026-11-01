import sys, time, subprocess
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import vision as bv

root = Path(sys.argv[1])
base = root / 'v3' / 'BV1234567890' / 'p1'
work = base / '11'
work.mkdir(parents=True, exist_ok=True)
meta = {'title': 'Synthetic video', 'bvid': 'BV1234567890', 'cid': 11, 'page': 1,
        'duration': 12, 'owner': 'fixture'}
bv.save_json(base / 'meta.json', {'saved': time.time(), 'meta': meta})
sig = bv.digest(['', '', '', ''])
bv.save_json(work / f'asr_{sig}.json',
             [{'start': i, 'end': i + 1, 'text': f'At second {i}: preserve this transcript.'} for i in range(12)])
subprocess.run([bv.ff(), '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=10', '-t', '12',
                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', str(work / 'video_720.mp4')],
               check=True, timeout=30,
               creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0)
