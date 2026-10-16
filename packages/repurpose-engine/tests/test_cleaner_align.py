import numpy as np
import pytest
from types import SimpleNamespace
from vidmyo_repurpose.cleaner_align import ctc_spans, aligned_words
from vidmyo_repurpose.cleaner_transcribe import decode_regions, quality_warnings, cleaner_cache_key


def test_acoustic_duration_is_not_inflated_by_edit_padding():
    word = {'id':'w1','text':'And','start_seconds':26.666,'end_seconds':28.186,
            'acoustic_start_seconds':27.766,'acoustic_end_seconds':27.906,'acoustic_confidence':.9}
    assert quality_warnings([word]) == []


def test_weak_word_does_not_discard_reliable_phrase_boundaries():
    words = [{'word':'A'}, {'word':'B'}, {'word':'C'}]
    aligned = aligned_words(words, ['A','B','C'],
                            [(0,2,.99),(2,3,.99),(3,5,.2),(5,6,.99),(6,8,.99)],0,2,.1)
    assert 'alignment_warning' not in aligned[0]
    assert aligned[1]['alignment_warning']['kind'] == 'low_acoustic_confidence'
    assert 'alignment_warning' not in aligned[2]
    assert aligned[0]['end'] == aligned[1]['start'] == pytest.approx(.25)
    assert aligned[1]['end'] == aligned[2]['start'] == pytest.approx(.55)


def test_alignment_version_invalidates_old_cache():
    assert cleaner_cache_key('source','model','en',alignment_version='v1') != cleaner_cache_key('source','model','en',alignment_version='v2')


def test_whole_speech_region_edge_does_not_inherit_interior_word_uncertainty():
    from vidmyo_repurpose.cleaner import _warning_blocks_segment
    word = {'id':'w1','text':'Video','start_seconds':2.176,'end_seconds':2.934,
            'acoustic_start_seconds':2.206,'acoustic_end_seconds':2.626,'acoustic_confidence':.4,
            'end_boundary_source':'speech_region',
            'alignment_warning':{'kind':'low_acoustic_confidence','message':'Weak word'}}
    warning = quality_warnings([word])[0]
    assert warning['boundary_seconds'] == [2.176]
    assert not _warning_blocks_segment(warning, {'start_seconds':1.066,'end_seconds':2.934})
    assert _warning_blocks_segment(warning, {'start_seconds':2.176,'end_seconds':2.934})


def emissions(sequence, size=4):
    result = np.full((len(sequence),size),-20.)
    result[np.arange(len(sequence)),sequence] = 0
    return result


def test_ctc_aligns_repeats_separately_and_does_not_attach_blank_to_word():
    spans=ctc_spans(emissions([0,1,1,0,2,0,1,0,2,0]),[1,2,1,2],0)
    assert [(a,b) for a,b,_ in spans] == [(1,3),(4,5),(6,7),(8,9)]
    assert all(score == 1 for _,_,score in spans)


def test_ctc_requires_blank_between_identical_characters():
    assert [(a,b) for a,b,_ in ctc_spans(emissions([1,0,1]),[1,1],0)] == [(0,1),(2,3)]
    with pytest.raises(ValueError): ctc_spans(emissions([1,1]),[1,1],0)
    with pytest.raises(ValueError): ctc_spans(emissions([]),[],0)


def test_decoder_uses_acoustic_shared_boundary_instead_of_whisper_clock():
    class ASR:
        def transcribe(self,*args,**kwargs):
            return iter([SimpleNamespace(start=0,end=2,text='And remember and remember',avg_logprob=0,
                words=[SimpleNamespace(word=w,start=i*.5,end=(i+1)*.5,probability=.9)
                       for i,w in enumerate(['And','remember','and','remember'])])]),None
    class Aligner:
        def align(self,audio,words,offset,limit):
            return [{**word,'start':s,'end':e} for word,s,e in zip(words,[0,.4,1.3,1.5],[.4,1.3,1.5,2])]
    segments,words,_=decode_regions(ASR(),[0]*32000,[{'start':0,'end':32000}],'en',aligner=Aligner())
    assert words[1]['end_seconds'] == words[2]['start_seconds'] == 1.3
    class Reject:
        def align(self,*args): raise ValueError('Wrong text')
    _,_,warnings=decode_regions(ASR(),[0]*32000,[{'start':0,'end':32000}],'en',aligner=Reject())
    assert any(w['start_seconds']==0 and w['end_seconds']==2 and 'uncertain' in w['message'] for w in warnings)


def test_multiple_decoder_segments_align_together_not_to_the_same_occurrence():
    class ASR:
        def transcribe(self,*args,**kwargs):
            return iter([SimpleNamespace(start=i,end=i+.5,text='Again',avg_logprob=0,
                words=[SimpleNamespace(word='Again',start=i,end=i+.5,probability=.9)]) for i in (0,1)]),None
    class Aligner:
        calls=0
        def align(self,audio,words,offset,limit):
            self.calls+=1
            assert len(words)==2
            return [{**word,'start':i,'end':i+1} for i,word in enumerate(words)]
    aligner=Aligner()
    _,words,_=decode_regions(ASR(),[0]*32000,[{'start':0,'end':32000}],'en',aligner=aligner)
    assert aligner.calls==1
    assert words[0]['end_seconds']==words[1]['start_seconds']==1
