import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import vision as bv

class VideoTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.work=Path(self.tmp.name)
        (self.work/'frames').mkdir()
    def tearDown(self):
        self.tmp.cleanup()
    def ctx(self,n=20):
        frames=[]
        for i in range(n):
            name=f'f_{i}.jpg'
            Image.new('RGB',(160,90),((i*11+20)%256,(i*23+20)%256,(i*39+20)%256)).save(self.work/'frames'/name)
            frames.append({'t':i*10.,'score':i/100,'file':name,'reason':'fixture'})
        units=[{'id':i,'t0':i*10.,'t1':i*10.+10,'text':'这个和那个不一样',
                'text_source':'subtitle'} for i in range(n)]
        return bv.Ctx('BV1234567890',{'title':'测试视频','duration':n*10},self.work,frames=frames,units=units,start=0,end=n*10,skeleton='subtitle',subtitle=[1])
    def args(self,*extra):
        args=bv.parser().parse_args(['inspect','BV1234567890','--no-ocr',*extra])
        args.grid_size=args.grid_size or 4
        return args
    def test_preserves_semantic_words_and_repetition(self):
        for text in ['这个和那个不一样','我们然后再操作','不要操作不要操作']:
            self.assertEqual(bv.compress_text(text),text)
    def test_uniform_indices_reaches_both_ends(self):
        ids=bv.uniform_indices(20,12)
        self.assertEqual(len(ids),12); self.assertEqual((ids[0],ids[-1]),(0,19))
    def test_timeline_selection_covers_end_even_unequal_scenes(self):
        ctx=self.ctx()
        for policy in ['auto','always']:
            selected=bv.select_frames(ctx,12,policy,'总结视频')
            self.assertEqual(len(selected),12)
            self.assertEqual((selected[0]['t'],selected[-1]['t']),(0,190))
    def test_long_static_scene_has_time_coverage(self):
        picked=bv.pick_frames([0]*600,2,[],300)
        self.assertGreater(len(picked),10)
        self.assertLessEqual(max(b['t']-a['t'] for a,b in zip(picked,picked[1:])),15.01)
    def test_budget_never_drops_head_tail(self):
        picked=bv.pick_frames([i/600 for i in range(600)],2,list(range(1,300)),300,max_frames=12)
        self.assertEqual(len(picked),12)
        self.assertEqual(picked[0]['t'],0)
        self.assertGreater(picked[-1]['t'],299)
    def test_units_attach_temporally_in_one_scene(self):
        ctx=self.ctx(10)
        bv.attach_scene_frames(ctx.units,ctx.frames,[],100)
        self.assertGreater(len({u['frame'] for u in ctx.units}),5)
    def test_ocr_reaches_model_evidence(self):
        ctx=self.ctx(3); args=self.args('--ocr')
        with patch.object(bv,'cached_ocr',return_value=[{'t':10,'text':'OCR_UNIQUE_123'}]):
            result=bv.build_evidence(ctx,args)
        self.assertIn('OCR_UNIQUE_123',result['text'])
        self.assertIn('[10.0s OCR]',result['text'])
    def test_grid_size_bounds_and_real_timestamps(self):
        result=bv.build_evidence(self.ctx(),self.args())
        self.assertEqual(len(result['images']),3)
        self.assertEqual(result['images'][-1]['times'][-1],190)
        with Image.open(result['images'][0]['path']) as im:
            self.assertLessEqual(im.width,960)
            self.assertGreater(im.height,180)
    def test_focused_range_excludes_unrelated_text_and_frames(self):
        ctx=self.ctx();ctx.start=50;ctx.end=80
        evidence=bv.build_evidence(ctx,self.args('--grid-size','1'))
        self.assertEqual(evidence['coverage']['selected_frame_times'],[50,60,70])
        self.assertNotIn('[0.0-10.0s',evidence['text'])
    def test_text_policy_has_no_images(self):
        evidence=bv.build_evidence(self.ctx(),self.args('--vision-policy','text'))
        self.assertEqual(evidence['images'],[])
    def test_text_only_prepare_never_downloads_video(self):
        args=self.args('--vision-policy','text','--subtitle-only')
        meta={'title':'test','duration':100,'cid':11,'bvid':'BV1234567890'}
        with patch.object(bv,'CACHE',self.work),patch.object(bv,'fetch_meta',return_value=meta),patch.object(bv,'download_video') as download:
            bv.prepare(args)
        download.assert_not_called()
    def test_pages_resolve_and_use_page_cid_duration(self):
        self.assertEqual(bv.resolve_target('https://www.bilibili.com/video/BV1234567890/?p=2'),('BV1234567890',2))
        data={'code':0,'data':{'aid':1,'title':'multi','owner':{'name':'owner'},'pages':[{'cid':2,'duration':10},{'cid':3,'duration':20}]}}
        with patch.object(bv,'_api',return_value=data):
            meta=bv.fetch_meta('BV1234567890',2)
        self.assertEqual((meta['cid'],meta['duration'],meta['page']),(3,20,2))
    def test_arbitrary_hosts_not_accepted(self):
        with self.assertRaises(ValueError):
            bv.resolve_target('https://evil.example/b23.tv/BV1234567890')
    def test_download_failure_does_not_poison_cache(self):
        class Broken:
            headers={}
            def __enter__(self): return self
            def __exit__(self,*a): pass
            def raise_for_status(self): pass
            def iter_content(self,*a):
                yield b'x'*4096
                raise OSError('disconnected')
        target=self.work/'video.mp4'
        with patch('requests.get',return_value=Broken()),self.assertRaises(OSError):
            bv.download_media('https://example.invalid',target,'BV1234567890')
        self.assertFalse(target.exists());self.assertFalse(target.with_suffix('.mp4.part').exists())
    def test_long_text_marks_omissions_and_keeps_tail(self):
        lines=[f'[{i}s] '+('内容'*50) for i in range(300)]
        text,missing=bv.fit_lines(lines,2000,'内容')
        self.assertGreater(missing,0);self.assertIn('省略',text)
        self.assertIn('[299s]',text)
    def test_chunks_preserve_all_characters_even_huge_line(self):
        text='A'*60000
        chunks=bv.chunk_lines([text],1000)
        self.assertEqual(''.join(chunks).replace('\n',''),text)
        self.assertTrue(all(bv.est_tokens(chunk)<=1000 for chunk in chunks))
    def test_single_request_for_normal_run_and_answer_cache(self):
        ctx=self.ctx(3);args=self.args()
        evidence=bv.build_evidence(ctx,args)
        with patch.object(bv,'_llm',return_value=('answer',{'total_tokens':123})) as llm,contextlib.redirect_stdout(io.StringIO()):
            bv.cmd_run(ctx,args,evidence);bv.cmd_run(ctx,args,evidence)
        self.assertEqual(llm.call_count,1)
        parts=llm.call_args.args[0]
        self.assertTrue(any(p['type']=='image_url' for p in parts))
        self.assertIn('这个和那个不一样',parts[0]['text'])
    def test_identical_pixels_dedup_retains_sample_times(self):
        ctx=self.ctx(12)
        first=(ctx.work/'frames'/ctx.frames[0]['file']).read_bytes()
        for f in ctx.frames:
            (ctx.work/'frames'/f['file']).write_bytes(first)
        result=bv.build_evidence(ctx,self.args())
        self.assertEqual(len(result['images']),1)
        self.assertEqual(len(result['coverage']['selected_frame_times']),12)
        self.assertIn('110.0s',result['text'])
        self.assertIn('完全相同',result['text'])
    def test_empty_black_frames_are_described_without_extra_images(self):
        ctx=self.ctx(5)
        Image.new('RGB',(160,90),'black').save(ctx.work/'frames'/ctx.frames[0]['file'])
        evidence=bv.build_evidence(ctx,self.args('--max-vision','5'))
        self.assertEqual(len(evidence['images']),1)
        self.assertIn('全黑画面',evidence['text'])
        self.assertEqual(len(evidence['coverage']['selected_frame_times']),5)

    def test_one_pixel_change_not_deduplicated(self):
        ctx=self.ctx(2)
        for i,f in enumerate(ctx.frames):
            im=Image.new('RGB',(160,90),'white')
            im.putpixel((10,10),(i,0,0))
            im.save(ctx.work/'frames'/f['file'],format='PNG')
        self.assertEqual(len(bv.deduplicate_frames(ctx,ctx.frames)),2)
    def test_long_run_reads_all_text_chunks(self):
        ctx=self.ctx(3);args=self.args('--max-text-tokens','2000')
        for u in ctx.units:
            u['text']='重要事实'*400
        ctx.units[-1]['text']+='TAIL_FACT_9876'
        evidence=bv.build_evidence(ctx,args)
        calls=[]
        def llm(parts,*a,**k):
            calls.append(parts)
            return 'note',{'total_tokens':10}
        with patch.object(bv,'_llm',side_effect=llm),contextlib.redirect_stdout(io.StringIO()):
            bv.cmd_run(ctx,args,evidence)
        self.assertGreater(len(calls),1)
        self.assertIn('TAIL_FACT_9876',json.dumps(calls[:-1]))

    def test_budget_does_not_assume_cache_hits(self):
        report=bv.budget_report('测试',3)
        self.assertFalse(report['cache_hit_assumed'])
    def test_no_evidence_prevents_paid_generation(self):
        ctx=bv.Ctx('BV1234567890',{'title':'empty'},self.work)
        args=self.args()
        with patch.object(bv,'_llm') as llm,self.assertRaises(RuntimeError):
            bv.cmd_run(ctx,args,{'images':[]})
        llm.assert_not_called()

class FFmpegTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.root=Path(cls.temp.name)
        cls.video=cls.root/'test.mp4'
        try:
            subprocess.run([bv.ff(),'-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=10',
                '-t','6','-c:v','libx264','-pix_fmt','yuv420p','-color_range','tv','-y',str(cls.video)],check=True,timeout=30)
        except (SystemExit,FileNotFoundError):
            cls.temp.cleanup();raise unittest.SkipTest('ffmpeg unavailable')
    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()
    def test_api_duration_longer_than_stream_does_not_fail_tail_extraction(self):
        args=bv.parser().parse_args(['inspect','BV1234567890','--no-asr','--no-ocr','--max-frames','12'])
        meta={'title':'rounding fixture','duration':7,'cid':11,'bvid':'BV1234567890'}
        with patch.object(bv,'CACHE',self.root/'cache'),patch.object(bv,'fetch_meta',return_value=meta),patch.object(bv,'download_video',return_value=self.video):
            ctx=bv.prepare(args)
        self.assertTrue(ctx.frames)
        self.assertLess(max(f['t'] for f in ctx.frames),6)
        self.assertTrue(all((ctx.work/'frames'/f['file']).exists() for f in ctx.frames))

    def test_streamed_scores_have_bounded_sample_count(self):
        scores,fps=bv.frame_scores(self.video)
        self.assertEqual(fps,2);self.assertEqual(len(scores),12)
        self.assertGreater(max(scores),0)
    def test_refresh_overwrites_stale_pixels_and_time_names_differ(self):
        out=self.root/'frames'
        first=bv.extract_frames(self.video,[{'t':1,'score':0,'reason':'test'}],out)
        path=out/first[0]['file'];original=path.read_bytes();path.write_bytes(b'stale')
        bv.extract_frames(self.video,[{'t':1,'score':0,'reason':'test'}],out,refresh=True)
        self.assertEqual(path.read_bytes(),original)
        second=bv.extract_frames(self.video,[{'t':4,'score':0,'reason':'test'}],out)
        self.assertNotEqual(first[0]['file'],second[0]['file'])
        self.assertNotEqual(path.read_bytes(),(out/second[0]['file']).read_bytes())

if __name__=='__main__':unittest.main(verbosity=2)
