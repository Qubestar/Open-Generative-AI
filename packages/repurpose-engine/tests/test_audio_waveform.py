import json
import shutil
import struct
import subprocess
import pytest
from vidmyo_repurpose.audio_waveform import pcm_peaks, source_waveform

def test_stream_chunks_and_silence_preserve_sample_positions():
    raw=struct.pack('<'+'h'*32,*([0]*16+[16384]*16))
    result=pcm_peaks([raw[:3],raw[3:17],raw[17:]],2,bins=16,rate=16)
    assert result['peaks'][:8]==[0]*8
    assert result['peaks'][8:]==[.5]*8

def test_invalid_and_empty_audio_are_not_fake_waveforms():
    with pytest.raises(ValueError): pcm_peaks([],2)
    with pytest.raises(ValueError): pcm_peaks([b'00'],float('nan'))

@pytest.mark.skipif(not shutil.which('ffmpeg'),reason='FFmpeg unavailable')
def test_real_audio_extraction_and_identity_cache(tmp_path):
    source=tmp_path/'source.wav'
    subprocess.run(['ffmpeg','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=1',str(source)],check=True)
    (tmp_path/'artifacts').mkdir()
    (tmp_path/'cleaner.json').write_text(json.dumps({'source':{'uri':str(source)}}))
    (tmp_path/'artifacts'/'ingest-artifact.v1.json').write_text(json.dumps({'container':{'duration_seconds':1}}))
    result=source_waveform(tmp_path)
    assert len(result['peaks'])==800
    assert max(result['peaks'])>0
    assert source_waveform(tmp_path)==result
    assert len(list((tmp_path/'artifacts').glob('cleaner-waveform-*.json')))==1
