"""异常路径测试：每一种失败都要给出「问题出在哪个阶段」的提示。

全部离线，不依赖真实 Cookie / 网络 / ffmpeg 之外的系统组件。
"""
import os
import shutil
import sys
import types
import unittest
import uuid
from pathlib import Path
from unittest import mock

import vision
import sources as vidsrc

ROOT = Path(__file__).resolve().parent


def mktmp(prefix: str) -> Path:
    path = ROOT / '.tmp-failures' / f'{prefix}-{os.getpid()}-{uuid.uuid4().hex[:8]}'
    path.mkdir(parents=True, exist_ok=True)
    return path


class FakeResp:
    def __init__(self, payload=None, status=200, text=''):
        self._payload = payload
        self.status_code = status
        self.text = text
        self.url = 'https://api.bilibili.com/x/web-interface/view'

    def raise_for_status(self):
        if self.status_code >= 400:
            err = RuntimeError(f'{self.status_code} error')
            err.response = self
            raise err

    def json(self):
        if self._payload is None:
            raise ValueError('Expecting value: line 1 column 1 (char 0)')
        return self._payload


class MetadataFailureTests(unittest.TestCase):
    def test_unknown_video_code_has_hint(self):
        with mock.patch.object(vision, '_bili_request', return_value=FakeResp({'code': -404, 'message': '啥都木有'})):
            with self.assertRaises(RuntimeError) as cm:
                vision.fetch_meta('BV1xx411c7mD')
        message = str(cm.exception)
        self.assertIn('-404', message)
        self.assertIn('视频不存在或已被删除', message)

    def test_expired_cookie_points_to_panel(self):
        with mock.patch.object(vision, '_bili_request', return_value=FakeResp({'code': -101, 'message': '账号未登录'})):
            with self.assertRaises(RuntimeError) as cm:
                vision.fetch_meta('BV1xx411c7mD')
        self.assertIn('Cookie 面板', str(cm.exception))

    def test_network_error_names_the_stage(self):
        def boom(*_args, **_kw):
            raise ConnectionError('getaddrinfo failed')
        with mock.patch.object(vision, '_bili_request', side_effect=boom):
            with self.assertRaises(RuntimeError) as cm:
                vision._api('/x/web-interface/view', {'bvid': 'BV1'})
        message = str(cm.exception)
        self.assertIn('/x/web-interface/view', message)
        self.assertIn('网络或代理', message)

    def test_html_instead_of_json_is_reported(self):
        with mock.patch.object(vision, '_bili_request', return_value=FakeResp(None)):
            with self.assertRaises(RuntimeError) as cm:
                vision._api('/x/web-interface/view', {'bvid': 'BV1'})
        self.assertIn('不是 JSON', str(cm.exception))

    def test_http_status_error_includes_status(self):
        with mock.patch.object(vision, '_bili_request', return_value=FakeResp({}, status=412)):
            with self.assertRaises(RuntimeError) as cm:
                vision._api('/x/web-interface/view', {'bvid': 'BV1'})
        self.assertIn('412', str(cm.exception))


class DiskAndBinaryTests(unittest.TestCase):
    def test_disk_full_is_a_distinct_error(self):
        self.root = mktmp('disk')
        try:
            usage = shutil._ntuple_diskusage(total=10 ** 12, used=10 ** 12, free=0) \
                if hasattr(shutil, '_ntuple_diskusage') else type('U', (), {'total': 1, 'used': 1, 'free': 0})()
            with mock.patch.object(vision.shutil, 'disk_usage', return_value=usage):
                with self.assertRaises(vision.DiskFullError) as cm:
                    vision.ensure_space(self.root)
            self.assertIn('磁盘空间不足', str(cm.exception))
        finally:
            shutil.rmtree(self.root, ignore_errors=True)

    def test_missing_ffmpeg_exits_with_actionable_message(self):
        with mock.patch.dict(os.environ, {}, clear=False), \
                mock.patch.object(vision, 'FFMPEG', None), \
                mock.patch.object(vision.shutil, 'which', return_value=None):
            os.environ.pop('YTDLP_VISION_FFMPEG', None)
            os.environ.pop('BILI_VISION_FFMPEG', None)
            with self.assertRaises(SystemExit) as cm:
                vision.ff()
        message = str(cm.exception.code)
        self.assertIn('ffmpeg', message)
        self.assertIn('YTDLP_VISION_FFMPEG', message)

    def test_missing_ffprobe_exits_with_actionable_message(self):
        # ffmpeg 能拿到（用 vision.py 自己占位），但同目录没有 ffprobe、PATH 里也没有
        with mock.patch.dict(os.environ, {}, clear=False), \
                mock.patch.object(vision, 'FFMPEG', str(Path(vision.__file__))), \
                mock.patch.object(vision, 'FFPROBE', None), \
                mock.patch.object(vision.shutil, 'which', return_value=None):
            os.environ.pop('YTDLP_VISION_FFPROBE', None)
            os.environ.pop('BILI_VISION_FFPROBE', None)
            with self.assertRaises(SystemExit) as cm:
                vision.fp()
        message = str(cm.exception.code)
        self.assertIn('ffprobe', message)
        # 提示要说明它通常和 ffmpeg 在一起，用户才知道去哪找
        self.assertIn('ffmpeg', message)

    def test_probe_local_propagates_ffprobe_error(self):
        def broken(cmd, **_kw):
            raise FileNotFoundError('ffprobe 不存在')
        with mock.patch.object(vision, 'run', side_effect=broken):
            with self.assertRaises(FileNotFoundError):
                vision.probe_local(Path('nope.mp4'))


class CorruptCacheTests(unittest.TestCase):
    def setUp(self):
        self.root = mktmp('corrupt')

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_corrupt_json_returns_none(self):
        path = self.root / 'meta.json'
        path.write_text('{not json', encoding='utf-8')
        self.assertIsNone(vision.load_json(path))

    def test_missing_json_returns_none(self):
        self.assertIsNone(vision.load_json(self.root / 'absent.json'))

    def test_write_is_atomic_and_readable(self):
        path = self.root / 'meta.json'
        vision.save_json(path, {'saved': 1, 'meta': {'title': '中文'}})
        self.assertEqual(vision.load_json(path)['meta']['title'], '中文')
        self.assertEqual([p.name for p in self.root.iterdir()], ['meta.json'])


class SubtitleFailureTests(unittest.TestCase):
    def test_non_public_subtitle_host_is_skipped(self):
        # 单条字幕地址不安全时跳过该条、交给转写，而不是整段失败
        result = vidsrc.fetch_subtitle_ytdlp(
            {'subtitles': {'en': [{'ext': 'vtt', 'url': 'http://127.0.0.1/a.vtt'}]}})
        self.assertIsNone(result)

    def test_metadata_cloud_endpoint_is_rejected(self):
        self.assertFalse(vidsrc._public_http_url('http://169.254.169.254/latest/meta-data/'))
        self.assertFalse(vidsrc._public_http_url('file:///etc/passwd'))

    def test_oversized_subtitle_is_rejected(self):
        class FakeStream:
            status_code = 200
            # 真实 requests 的 headers 是 CaseInsensitiveDict，这里用小写键贴近其行为
            headers = {'content-length': str(vidsrc.MAX_SUBTITLE_BYTES + 10)}

            def raise_for_status(self): pass

            def close(self): pass

            def iter_content(self, _size=1):
                yield b'x' * 1024

        class FakeRequests:
            @staticmethod
            def get(*_args, **_kw):
                return FakeStream()

        with self.assertRaises(RuntimeError) as cm:
            vidsrc._get_limited(FakeRequests, 'https://example.com/a.vtt',
                                timeout=5, limit=vidsrc.MAX_SUBTITLE_BYTES)
        self.assertIn('体积超过', str(cm.exception))


class AsrCacheKeyTests(unittest.TestCase):
    """转写缓存不能把旧分析结果套到换了音轨的视频上。"""

    def setUp(self):
        self.root = mktmp('asr')
        self.audio = self.root / 'audio.m4a'
        self.audio.write_bytes(b'x' * 2048)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_same_audio_same_signature(self):
        self.assertEqual(vision.asr_signature(self.audio), vision.asr_signature(self.audio))

    def test_replaced_audio_changes_signature(self):
        before = vision.asr_signature(self.audio)
        self.audio.write_bytes(b'y' * 4096)
        self.assertNotEqual(before, vision.asr_signature(self.audio))

    def test_touched_audio_changes_signature(self):
        before = vision.asr_signature(self.audio)
        os.utime(self.audio, ns=(1, 1))
        self.assertNotEqual(before, vision.asr_signature(self.audio))

    def test_missing_audio_still_stable(self):
        missing = self.root / 'gone.m4a'
        self.assertEqual(vision.asr_signature(missing), vision.asr_signature(None))

    def test_model_change_changes_signature(self):
        before = vision.asr_signature(self.audio)
        with mock.patch.dict(os.environ, {'YTDLP_VISION_ASR_MODEL': 'small'}):
            self.assertNotEqual(before, vision.asr_signature(self.audio))


class AsrDegradeTests(unittest.TestCase):
    """ASR 不可用时必须降级到字幕/画面，而不是让整次分析失败。

    `transcribe()` 有三条独立的失败出口，任何一条都要返回空列表：
      1. 没装 faster-whisper       —— ImportError
      2. 模型加载/下载失败          —— WhisperModel(...) 抛异常
      3. 转写过程失败              —— m.transcribe(...) 抛异常
    """

    def test_no_faster_whisper_returns_empty(self):
        with mock.patch.dict(sys.modules, {'faster_whisper': None}):
            self.assertEqual(vision.transcribe(Path('nope.m4a')), [])

    def test_model_load_failure_returns_empty(self):
        fake = types.ModuleType('faster_whisper')

        class Boom:
            def __init__(self, *_args, **_kw):
                raise RuntimeError('模型下载失败（mock）')

        fake.WhisperModel = Boom
        with mock.patch.dict(sys.modules, {'faster_whisper': fake}):
            self.assertEqual(vision.transcribe(Path('nope.m4a')), [])

    def test_transcribe_failure_returns_empty(self):
        fake = types.ModuleType('faster_whisper')

        class Model:
            def __init__(self, *_args, **_kw): pass

            def transcribe(self, *_args, **_kw):
                raise RuntimeError('ctranslate2 崩了（mock）')

        fake.WhisperModel = Model
        # 不依赖 av：解码阶段也让它失败，这样一定走到 m.transcribe 那条出口
        with mock.patch.dict(sys.modules, {'faster_whisper': fake}), \
                mock.patch.object(vision, '_decode_audio', side_effect=RuntimeError('decode fail')):
            self.assertEqual(vision.transcribe(Path('nope.m4a')), [])

    def test_overlong_audio_is_skipped_not_truncated(self):
        import numpy as np
        fake = types.ModuleType('faster_whisper')
        fake.WhisperModel = lambda *_a, **_kw: object()
        with mock.patch.dict(sys.modules, {'faster_whisper': fake}), \
                mock.patch.object(vision, '_decode_audio', return_value=np.zeros(16000 * 10)), \
                mock.patch.object(vision, 'MAX_ASR_SECONDS', 5.0):
            self.assertEqual(vision.transcribe(Path('nope.m4a')), [])


if __name__ == '__main__':
    unittest.main()
