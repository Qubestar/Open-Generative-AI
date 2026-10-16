from types import SimpleNamespace

import pytest

from vidmyo_repurpose.cleaner import repeated_takes
from vidmyo_repurpose.cleaner_transcribe import decode_regions, quality_warnings, split_retake_segments, uncovered_audio, recover_repeated_tail


def test_sparse_suffix_recheck_recovers_repetition_but_not_unrelated_hallucination():
    original = SimpleNamespace(words=[SimpleNamespace(word=w, start=s, end=e, probability=.9)
        for w,s,e in [('And',0,1.2),('remember',1.2,2),('to',2,3.2),('subscribe',3.2,3.6)]])
    class Retry:
        def __init__(self, phrase): self.phrase=phrase
        def transcribe(self, *_args, **options):
            assert 'initial_prompt' not in options
            return iter([SimpleNamespace(words=[SimpleNamespace(word=w,start=i*.3,end=(i+1)*.3,probability=.9)
                for i,w in enumerate(self.phrase.split())])]), None
    recovered = recover_repeated_tail(Retry('remember And remember to subscribe'), [0]*64000, original, 0, 4, 'en')
    assert [w['word'] for w in recovered] == ['And','remember','And','remember','to','subscribe']
    assert recovered[2]['start'] == pytest.approx(1.5)
    rejected = recover_repeated_tail(Retry('remember buy something to subscribe'), [0]*64000, original, 0, 4, 'en')
    assert len(rejected) == 4


def test_partial_earlier_take_and_two_word_restart_get_independent_units():
    phrases = ['Later how it looks like, you just simply click the link below in this video.',
               'Simply click the link below this video in the description.',
               'And remember. And remember to subscribe.']
    segments, words = [], []
    for i, phrase in enumerate(phrases):
        selected = []
        for j, token in enumerate(phrase.split()):
            word = dict(id=f'w{len(words)}', segment_id=f's{i}', text=token,
                        start_seconds=i*10+j*.2, end_seconds=i*10+(j+1)*.2, confidence=.9)
            words.append(word)
            selected.append(word['id'])
        segments.append(dict(id=f's{i}', text=phrase, word_ids=selected, start_seconds=i*10,
                             end_seconds=words[-1]['end_seconds'], confidence=.9))
    units = split_retake_segments(segments, words)
    assert [u['text'] for u in units] == [
        'Later how it looks like,', 'you just simply click the link below in this video.',
        phrases[1], 'And remember.', 'And remember to subscribe.']
    assert [w for u in units for w in u['word_ids']] == [w['id'] for w in words]


def test_untranscribed_audio_is_reviewable_not_assumed_silence():
    import numpy as np
    audio = np.zeros(48000, dtype=np.float32)
    audio[8000:12800] = .1  # unexplained sound, potentially a cough
    audio[24000:32000] = .1  # covered speech
    events = uncovered_audio(audio, [{'start_seconds':1.4,'end_seconds':2.1}])
    assert len(events) == 1
    assert events[0]['start_seconds'] <= .5
    assert events[0]['end_seconds'] >= .8
    assert 'cough' in events[0]['message']
    assert uncovered_audio(np.zeros(16000), []) == []


def test_low_confidence_noise_is_not_presented_as_a_confident_spoken_word():
    class Noise:
        def transcribe(self, *_args, **_kwargs):
            return iter([SimpleNamespace(start=0,end=.3,text='OK.',avg_logprob=-1,
                words=[SimpleNamespace(word='OK.',start=0,end=.3,probability=.003)])]), None
    segments, words, warnings = decode_regions(Noise(), [0]*16000, [{'start':0,'end':16000}], 'en')
    assert segments == words == []
    assert warnings[0]['kind'] == 'audio_event'
    assert warnings[0]['end_seconds'] == 1


def test_take_end_covers_audio_beyond_early_asr_word_end():
    class Model:
        def transcribe(self,*_args,**_kwargs):
            return iter([SimpleNamespace(start=.1,end=.4,text='description',avg_logprob=-.1,
                words=[SimpleNamespace(word='description',start=.1,end=.4,probability=.9)])]),None
    segments,words,_ = decode_regions(Model(), [0]*16000, [{'start':0,'end':16000}], 'en')
    assert words[-1]['end_seconds'] == segments[-1]['end_seconds'] == 1
    assert words[0]['start_seconds'] == 0


def test_retake_hints_do_not_claim_negated_content_is_preserved():
    pair = repeated_takes([
        {'id':'a', 'text':'Do not click the link below.', 'start_seconds':0, 'end_seconds':2},
        {'id':'b', 'text':'Do click the link below.', 'start_seconds':3, 'end_seconds':5}])[0]
    assert pair['preserves_content'] is False


def test_each_region_preserves_the_same_words_again_with_source_timestamps():
    class Model:
        calls = []
        def transcribe(self, audio, **options):
            self.calls.append(options)
            words = [SimpleNamespace(word=text, start=i*.2, end=(i+1)*.2, probability=.9)
                     for i, text in enumerate(['This', 'is', 'a', 'test'])]
            return iter([SimpleNamespace(start=0, end=.8, text='This is a test', avg_logprob=-.1, words=words)]), None
    model = Model()
    segments, words, warnings = decode_regions(model, [0]*64000,
        [{'start': 0, 'end': 16000}, {'start': 32000, 'end': 48000}], 'en')
    assert [item['text'] for item in segments] == ['This is a test', 'This is a test']
    assert words[4]['start_seconds'] == 2
    assert words[-1]['end_seconds'] == pytest.approx(3)
    assert len({word['id'] for word in words}) == 8
    assert all(call['condition_on_previous_text'] is False for call in model.calls)
    assert warnings == []
    assert repeated_takes(segments)[0]['later'] == segments[1]['id']


def test_suspicious_alignment_and_untranscribed_speech_are_flagged():
    assert quality_warnings([{'text': 'and', 'start_seconds': 2.5, 'end_seconds': 11}])
    class Empty:
        def transcribe(self, *_args, **_kwargs): return iter([]), None
    _, _, warnings = decode_regions(Empty(), [0]*16000, [{'start': 0, 'end': 16000}], 'en')
    assert 'no words' in warnings[0]['message']
