"""缓存统计与清理的离线测试。

要点：清理不能误删正在使用的缓存（靠 video_lock 同名的锁文件判断），
dry-run 不能真删，历史版本与 TTL/容量上限要真的生效。
"""
import os
import shutil
import time
import unittest
import uuid
from pathlib import Path
from unittest import mock

import vision

ROOT = Path(__file__).resolve().parent


def mktmp(prefix: str) -> Path:
    path = ROOT / '.tmp-cache' / f'{prefix}-{os.getpid()}-{uuid.uuid4().hex[:8]}'
    path.mkdir(parents=True, exist_ok=True)
    return path


def make_entry(root: Path, version: str, bvid: str, page: str = 'p1', payload: int = 100) -> Path:
    entry = root / version / bvid / page
    entry.mkdir(parents=True, exist_ok=True)
    (entry / 'data.bin').write_bytes(b'x' * payload)
    return root / version / bvid


class CacheStatsTests(unittest.TestCase):
    def setUp(self):
        self.root = mktmp('stats')
        self.patch = mock.patch.object(vision, 'CACHE', self.root)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        shutil.rmtree(self.root, ignore_errors=True)

    def test_totals_and_versions(self):
        make_entry(self.root, 'v3', 'BV1', payload=1000)
        make_entry(self.root, 'v1', 'old', payload=500)
        stats = vision.cache_stats()
        self.assertEqual(stats['bytes'], 1500)
        self.assertEqual(stats['files'], 2)
        names = {item['name']: item for item in stats['versions']}
        self.assertTrue(names['v3']['current'])
        self.assertFalse(names['v1']['current'])
        self.assertEqual(stats['largest'][0]['name'], 'BV1')

    def test_empty_cache(self):
        stats = vision.cache_stats()
        self.assertEqual(stats['bytes'], 0)
        self.assertEqual(stats['versions'], [])


class CacheCleanTests(unittest.TestCase):
    def setUp(self):
        self.root = mktmp('clean')
        self.patch = mock.patch.object(vision, 'CACHE', self.root)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        shutil.rmtree(self.root, ignore_errors=True)

    def test_old_versions_removed_current_kept(self):
        make_entry(self.root, 'v1', 'old')
        make_entry(self.root, 'v2', 'old2')
        keep = make_entry(self.root, 'v3', 'BVkeep')
        report = vision.cache_clean(ttl_days=0, max_bytes=1 << 30)
        self.assertFalse((self.root / 'v1').exists())
        self.assertFalse((self.root / 'v2').exists())
        self.assertTrue(keep.exists())
        self.assertTrue(any('旧缓存版本' in item['reason'] for item in report['removed']))

    def test_dry_run_deletes_nothing(self):
        entry = make_entry(self.root, 'v3', 'BV1')
        report = vision.cache_clean(dry_run=True, ttl_days=0, max_bytes=0)
        self.assertTrue(entry.exists())
        self.assertTrue(report['dry_run'])
        self.assertTrue(report['removed'])
        self.assertTrue(all('dry-run' in item['reason'] for item in report['removed']))

    def test_ttl_removes_stale_entry(self):
        stale = make_entry(self.root, 'v3', 'BVstale')
        fresh = make_entry(self.root, 'v3', 'BVfresh')
        old = time.time() - 40 * 86400
        for path in stale.rglob('*'):
            os.utime(path, (old, old))
        os.utime(stale, (old, old))
        vision.cache_clean(ttl_days=30, max_bytes=1 << 30)
        self.assertFalse(stale.exists())
        self.assertTrue(fresh.exists())

    def test_size_cap_keeps_newest(self):
        oldest = make_entry(self.root, 'v3', 'BV1', payload=1000)
        middle = make_entry(self.root, 'v3', 'BV2', payload=1000)
        newest = make_entry(self.root, 'v3', 'BV3', payload=1000)
        now = time.time()
        os.utime(oldest, (now - 3000, now - 3000))
        os.utime(middle, (now - 2000, now - 2000))
        os.utime(newest, (now - 1000, now - 1000))
        report = vision.cache_clean(ttl_days=0, max_bytes=2500, keep_newest=1)
        self.assertTrue(newest.exists())
        self.assertFalse(oldest.exists())
        # 2500 字节放不下两个 1000 字节条目 + 保留策略，至少要删掉最旧的一个
        self.assertTrue(any('上限' in item['reason'] for item in report['removed']))

    def test_locked_entry_is_skipped(self):
        busy = make_entry(self.root, 'v3', 'BVbusy', payload=1000)
        free = make_entry(self.root, 'v3', 'BVfree', payload=1000)
        handle = vision._lock_handle(self.root / 'BVbusy_p1.lock')
        self.assertIsNotNone(handle, '测试自身应该能拿到锁')
        try:
            report = vision.cache_clean(ttl_days=0, max_bytes=0, keep_newest=0)
            self.assertTrue(busy.exists(), '正在使用的缓存不能被删')
            self.assertFalse(free.exists())
            self.assertTrue(report['skipped'])
        finally:
            vision._unlock_handle(handle)

    def test_unsafe_names_never_removed(self):
        weird = self.root / 'v3' / 'weird name'
        weird.mkdir(parents=True)
        (weird / 'x.bin').write_bytes(b'x' * 10)
        inner = self.root / 'v3' / 'BV1' / 'not-a-page'
        inner.mkdir(parents=True)
        vision.cache_clean(ttl_days=0, max_bytes=0, keep_newest=0)
        self.assertTrue(weird.exists())
        self.assertTrue(inner.exists())


if __name__ == '__main__':
    unittest.main()
