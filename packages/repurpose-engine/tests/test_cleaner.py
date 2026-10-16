import json
import subprocess
from pathlib import Path

import pytest

from vidmyo_repurpose.cleaner import CleanerError, analysis_units, build_plan, kept_ranges, render_plan, waveform_units, review_plan, preview_source, preview_edit


class StubProvider:
    def __init__(self, response):
        self.response = response
        self.requests = []

    def structured(self, request):
        self.requests.append(request)
        return self.response


def test_reanalysis_does_not_preserve_unreviewed_safety_hold(tmp_path):
    project(tmp_path)
    provider = StubProvider({'cuts':[{'segment_id':'segment_000001','category':'retake','reason':'Earlier take'}]})
    previous = build_plan(tmp_path, provider_factory=lambda *_:provider)
    previous['decisions'][0].update(decision='keep', needs_review=True, reviewed=False)
    write_json(tmp_path/'artifacts/cleaner-plan.v1.json',previous)
    fresh = build_plan(tmp_path, provider_factory=lambda *_:provider)
    assert fresh['decisions'][0]['decision'] == 'cut'
    assert not fresh['decisions'][0].get('preserved_override')
    assert list((tmp_path/'artifacts/cleaner-plan-history').glob('*.json'))


def test_reanalysis_preserves_explicit_reviewed_choice(tmp_path):
    project(tmp_path)
    provider = StubProvider({'cuts':[{'segment_id':'segment_000001','category':'retake','reason':'Earlier take'}]})
    previous = build_plan(tmp_path, provider_factory=lambda *_:provider)
    previous['decisions'][0].update(decision='keep', reviewed=True)
    write_json(tmp_path/'artifacts/cleaner-plan.v1.json',previous)
    fresh = build_plan(tmp_path, provider_factory=lambda *_:provider)
    assert fresh['decisions'][0]['decision'] == 'keep'
    assert fresh['decisions'][0]['preserved_override']
    assert fresh['summary']['proposed_cuts'] == 1
    assert fresh['summary']['applied_cuts'] == 0


def test_unmatched_review_choice_is_visible_and_requires_new_review(tmp_path):
    project(tmp_path)
    provider = StubProvider({'cuts':[]})
    previous = build_plan(tmp_path, provider_factory=lambda *_:provider)
    previous['decisions'][0].update(text='Old transcript text', decision='cut', reviewed=True)
    write_json(tmp_path/'artifacts/cleaner-plan.v1.json',previous)
    build_plan(tmp_path, provider_factory=lambda *_:provider)
    fresh = review_plan(tmp_path)
    assert fresh['unresolved_reanalysis_overrides'][0]['text'] == 'Old transcript text'
    item = next(item for item in fresh['decisions'] if item['segment_id']=='segment_000001')
    assert item['needs_review'] and not item['reviewed']


def test_localized_warning_blocks_only_touching_cut_boundaries():
    from vidmyo_repurpose.cleaner import _warning_blocks_segment
    warning = {'start_seconds':1.2,'end_seconds':1.4,'boundary_seconds':[1.1,1.5]}
    assert _warning_blocks_segment(warning, {'start_seconds':1.1,'end_seconds':2})
    assert not _warning_blocks_segment(warning, {'start_seconds':0,'end_seconds':2})


def test_cleaned_preview_physically_excludes_removed_audio_and_invalidates_cache(tmp_path):
    import numpy as np
    source = tmp_path/'tones.mp4'
    subprocess.run(['ffmpeg','-nostdin','-v','error','-y',
        '-f','lavfi','-i','color=c=black:s=160x90:r=25:d=3',
        '-f','lavfi','-i',r'aevalsrc=sin(2*PI*if(between(t\,1\,2)\,880\,440)*t):d=3:s=48000',
        '-c:v','libx264','-c:a','aac','-shortest',str(source)],check=True)
    project(tmp_path,source=source)
    write_json(tmp_path/'artifacts/ingest-artifact.v1.json',{'container':{'duration_seconds':3}})
    plan = {'review_version':2,'decisions':[
        {'segment_id':'segment_000001','start_seconds':1,'end_seconds':2,'text':'Remove tone',
         'proposed':'cut','decision':'cut','needs_review':True}], 'summary':{}}
    write_json(tmp_path/'artifacts/cleaner-plan.v1.json',plan)
    edited = preview_edit(tmp_path)
    assert preview_edit(tmp_path) == edited
    def samples(file):
        raw = subprocess.run(['ffmpeg','-v','error','-i',str(file),'-f','f32le','-ac','1','-ar','16000','-'],capture_output=True,check=True).stdout
        return np.frombuffer(raw,dtype=np.float32)
    def energy(audio,hz):
        spectrum = abs(np.fft.rfft(audio))
        frequencies = np.fft.rfftfreq(len(audio),1/16000)
        return spectrum[abs(frequencies-hz)<5].sum()
    audio = samples(edited)
    assert len(audio)/16000 == pytest.approx(2,abs=.08)
    assert energy(audio,880) < energy(audio,440)*.03
    # A corrected boundary must change the actual media, not only the labels.
    plan['decisions'][0]['end_seconds'] = 1.8
    write_json(tmp_path/'artifacts/cleaner-plan.v1.json',plan)
    adjusted = preview_edit(tmp_path)
    assert adjusted != edited
    adjusted_audio = samples(adjusted)
    assert len(adjusted_audio)/16000 == pytest.approx(2.2,abs=.08)
    assert energy(adjusted_audio,880) > energy(adjusted_audio,440)*.05
    plan['decisions'][0]['decision']='keep'
    write_json(tmp_path/'artifacts/cleaner-plan.v1.json',plan)
    restored = preview_edit(tmp_path)
    assert restored != edited
    restored_audio = samples(restored)
    assert len(restored_audio)/16000 == pytest.approx(3,abs=.08)
    assert energy(restored_audio,880) > energy(restored_audio,440)*.2
    assert not (tmp_path/'exports/cleaned-video.mp4').exists()


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def project(tmp_path: Path, *, source: Path | None = None):
    source = source or tmp_path / "source.mp4"
    write_json(tmp_path / "cleaner.json", {
        "source": {"type": "local_file", "uri": str(source)},
        "intake": {"script_mode": "freestyle", "script_text": None},
        "cleanup": {"remove_dead_air": True},
        "analysis": {"mode": "agent", "provider": "codex", "model": None},
    })
    write_json(tmp_path / "artifacts" / "transcript-artifact.v1.json", {
        "segments": [
            {"id": "whisper_1", "start_seconds": 0.2, "end_seconds": 1.2, "text": "This is the first attempt.", "word_ids": []},
            {"id": "whisper_2", "start_seconds": 1.5, "end_seconds": 2.6, "text": "This is the complete first attempt.", "word_ids": []},
            {"id": "whisper_3", "start_seconds": 4.8, "end_seconds": 5.7, "text": "And this is the ending.", "word_ids": []},
        ]
    })
    write_json(tmp_path / "artifacts" / "ingest-artifact.v1.json", {
        "container": {"duration_seconds": 6.0}
    })
    return source


def test_build_plan_is_conservative_reviewable_and_provider_grounded(tmp_path):
    project(tmp_path)
    provider = StubProvider({"cuts": [{
        "segment_id": "segment_000001", "category": "retake", "reason": "Earlier incomplete take."
    }]})
    events = []
    plan = build_plan(tmp_path, provider_factory=lambda *_args, **_kwargs: provider, progress=events.append)
    assert [item["decision"] for item in plan["decisions"]] == ["cut", "keep", "keep"]
    assert plan["summary"] == {"segments": 3, "proposed_cuts": 1, "applied_cuts": 1, "boundary_source": "transcript"}
    assert provider.requests[0]["schema_name"] == "vidmyo_cleaner_cuts_v1"
    assert "filler words" in provider.requests[0]["messages"][1]["content"]
    assert events[-1]["fraction"] == 1.0
    assert json.loads((tmp_path / "artifacts" / "cleaner-plan.v1.json").read_text())["version"] == 1


def test_build_plan_rejects_hallucinated_segment_ids(tmp_path):
    project(tmp_path)
    provider = StubProvider({"cuts": [{
        "segment_id": "segment_999999", "category": "retake", "reason": "Not real."
    }]})
    with pytest.raises(CleanerError, match="unknown transcript segment"):
        build_plan(tmp_path, provider_factory=lambda *_args, **_kwargs: provider)


def test_analysis_units_expose_a_restart_hidden_inside_one_whisper_segment():
    transcript = {
        "words": [
            {"id": "word_1", "start_seconds": 0.1, "end_seconds": 0.5, "text": "The"},
            {"id": "word_2", "start_seconds": 0.52, "end_seconds": 0.9, "text": "wrong"},
            {"id": "word_3", "start_seconds": 1.3, "end_seconds": 1.65, "text": "The"},
            {"id": "word_4", "start_seconds": 1.67, "end_seconds": 2.1, "text": "complete"},
        ],
        "segments": [{"word_ids": ["word_1", "word_2", "word_3", "word_4"], "text": "The wrong The complete"}],
    }
    assert analysis_units(transcript) == [
        {"id": "segment_000001", "start_seconds": 0.1, "end_seconds": 0.9, "text": "The wrong"},
        {"id": "segment_000002", "start_seconds": 1.3, "end_seconds": 2.1, "text": "The complete"},
    ]


def test_short_earlier_restart_is_suggested_even_if_provider_keeps_everything(tmp_path):
    from vidmyo_repurpose.cleaner_transcribe import STRATEGY
    project(tmp_path)
    write_json(tmp_path/'artifacts/cleaner-transcript.v1.json', {
        'cleaner_strategy': STRATEGY, 'segments': [
            {'id':'s1', 'start_seconds':1, 'end_seconds':2, 'text':'And remember.'},
            {'id':'s2', 'start_seconds':2.2, 'end_seconds':4, 'text':'And remember to subscribe.'}],
        'quality_warnings':[{'start_seconds':4.5,'end_seconds':5,'kind':'audio_event','message':'Possible cough: listen.'}]
    })
    result = build_plan(tmp_path, provider_factory=lambda *_: StubProvider({'cuts':[]}))
    first, later, audio = result['decisions']
    assert first['proposed'] == first['decision'] == 'cut'
    assert first['needs_review'] is True
    assert later['decision'] == 'keep'
    assert audio['category'] == 'untranscribed' and audio['needs_review']
    with pytest.raises(CleanerError, match='flagged'):
        render_plan(tmp_path)


def test_uncertain_join_flags_both_sides_once_without_changing_saved_choices(tmp_path):
    from vidmyo_repurpose.cleaner_transcribe import STRATEGY
    project(tmp_path)
    target = tmp_path/'artifacts/cleaner-plan.v1.json'
    write_json(target, {'review_version':2, 'transcript_strategy':STRATEGY,
        'quality_warnings':[{'start_seconds':1,'end_seconds':2}], 'decisions':[
            {'segment_id':'segment_000001','start_seconds':0,'end_seconds':2,'text':'And remember','decision':'cut','reviewed':True},
            {'segment_id':'segment_000002','start_seconds':2,'end_seconds':6,'text':'And remember to subscribe','decision':'keep','reviewed':True}], 'summary':{}})
    plan = review_plan(tmp_path)
    assert all(d['join_warning'] and not d['reviewed'] for d in plan['decisions'])
    assert [d['decision'] for d in plan['decisions']] == ['cut','keep']
    for d in plan['decisions']: d['reviewed'] = True
    plan['decisions'][0]['end_seconds'] = plan['decisions'][1]['start_seconds'] = 2.25
    write_json(target, plan)
    corrected = review_plan(tmp_path)
    assert all(d['reviewed'] for d in corrected['decisions'])
    assert corrected['kept_ranges'] == [(2.25,6)]


def test_exact_review_never_removes_hidden_padding_or_short_restored_audio():
    plan = {'review_version':2, 'decisions':[
        {'start_seconds':0,'end_seconds':1,'decision':'cut'},
        {'start_seconds':1,'end_seconds':1.02,'decision':'keep'},
        {'start_seconds':1.02,'end_seconds':2,'decision':'cut'}]}
    assert kept_ranges(plan, 2) == [(1,1.02)]
    plan['decisions'][0]['decision'] = 'keep'
    assert kept_ranges(plan, 2) == [(0,1.02)]


def test_review_covers_every_source_interval_and_all_removals_are_restorable(tmp_path):
    from vidmyo_repurpose.cleaner_transcribe import STRATEGY
    project(tmp_path)
    write_json(tmp_path/'artifacts/cleaner-plan.v1.json', {
        'transcript_strategy':STRATEGY, 'decisions':[
            {'segment_id':'segment_000001','start_seconds':1,'end_seconds':2,'text':'First take','decision':'cut'},
            {'segment_id':'segment_000002','start_seconds':2.1,'end_seconds':4,'text':'Full take','decision':'keep'}],
        'summary':{}})
    plan = review_plan(tmp_path)
    assert plan['review_version'] == 2
    assert plan['decisions'][0]['start_seconds'] == 0
    assert plan['decisions'][-1]['end_seconds'] == 6
    assert all(a['end_seconds'] == b['start_seconds'] for a,b in zip(plan['decisions'],plan['decisions'][1:]))
    for d in plan['decisions']: d['decision']='keep'
    assert kept_ranges(plan,6) == [(0,6)]


@pytest.mark.skipif(subprocess.run(["sh", "-c", "command -v ffmpeg"], capture_output=True).returncode != 0, reason="ffmpeg missing")
def test_waveform_units_use_real_silence_to_separate_attempts(tmp_path):
    source = tmp_path / "waveform.mp4"
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=black:s=160x90:r=25:d=3",
        "-f", "lavfi", "-i", "aevalsrc=0:d=0.5:s=48000",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.8",
        "-f", "lavfi", "-i", "aevalsrc=0:d=0.45:s=48000",
        "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=0.8",
        "-filter_complex", "[1:a][2:a][3:a][4:a]concat=n=4:v=0:a=1[a]",
        "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(source),
    ], check=True)
    transcript = {
        "words": [
            {"id": "w1", "start_seconds": 0.55, "end_seconds": 0.9, "text": "first"},
            {"id": "w2", "start_seconds": 1.8, "end_seconds": 2.15, "text": "second"},
        ],
        "segments": [{"word_ids": ["w1", "w2"], "text": "first second"}],
    }
    units = waveform_units(source, transcript, 3.0)
    assert [item["text"] for item in units] == ["first", "second"]
    assert units[0]["start_seconds"] == pytest.approx(0.5, abs=0.08)


def test_kept_ranges_remove_reviewed_cuts_and_only_long_dead_air():
    plan = {"decisions": [
        {"start_seconds": 0.2, "end_seconds": 1.2, "decision": "cut"},
        {"start_seconds": 1.5, "end_seconds": 2.6, "decision": "keep"},
        {"start_seconds": 4.8, "end_seconds": 5.7, "decision": "keep"},
    ]}
    assert kept_ranges(plan, 6.0) == pytest.approx([(1.28, 2.9), (4.5, 6.0)])


@pytest.mark.skipif(subprocess.run(["sh", "-c", "command -v ffmpeg"], capture_output=True).returncode != 0, reason="ffmpeg missing")
def test_render_plan_creates_one_decodable_local_mp4(tmp_path):
    source = tmp_path / "source.mp4"
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=25:d=6",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(source),
    ], check=True)
    project(tmp_path, source=source)
    write_json(tmp_path / "artifacts" / "cleaner-plan.v1.json", {
        "version": 1,
        "decisions": [
            {"segment_id": "segment_000001", "start_seconds": 0.8, "end_seconds": 1.8, "decision": "cut"},
            {"segment_id": "segment_000002", "start_seconds": 2.0, "end_seconds": 3.0, "decision": "keep"},
        ],
    })
    output = render_plan(tmp_path)
    assert output.is_file() and output.stat().st_size > 0
    probe = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(output)
    ], text=True, capture_output=True, check=True)
    assert 4.7 < float(probe.stdout) < 5.2
    preview = preview_source(tmp_path)
    original_mtime = preview.stat().st_mtime_ns
    assert preview_source(tmp_path).stat().st_mtime_ns == original_mtime
    subprocess.run(['ffmpeg', '-v', 'error', '-i', str(preview), '-f', 'null', '-'], check=True, capture_output=True)


def test_review_exposes_hidden_pauses_and_restoring_them_preserves_full_source(tmp_path):
    project(tmp_path)
    build_plan(tmp_path, provider_factory=lambda *_: StubProvider({'cuts': []}))
    plan = review_plan(tmp_path)
    pauses = [item for item in plan['decisions'] if item.get('category') == 'pause']
    assert len(pauses) == 1
    assert plan['summary']['speech_cuts'] == 0
    assert plan['summary']['pause_cuts'] == 1
    assert plan['summary']['removed_seconds'] == pytest.approx(1.6)
    assert plan['kept_ranges'] == [[0.0, 2.9], [4.5, 6.0]] or plan['kept_ranges'] == [(0.0, 2.9), (4.5, 6.0)]
    pauses[0]['decision'] = 'keep'
    write_json(tmp_path / 'artifacts' / 'cleaner-plan.v1.json', plan)
    restored = review_plan(tmp_path)
    assert restored['summary']['removed_seconds'] == 0
    assert restored['kept_ranges'] == [(0.0, 6.0)]
    assert len(restored['decisions']) == len(plan['decisions'])


def test_waveform_missed_quiet_word_falls_back_without_losing_speech(monkeypatch):
    monkeypatch.setattr('vidmyo_repurpose.cleaner._silences', lambda *_: ([1.0], [2.0]))
    transcript = {'words': [
        {'id': 'w1', 'text': 'Audible', 'start_seconds': 0.1, 'end_seconds': 0.8},
        {'id': 'w2', 'text': 'quiet', 'start_seconds': 1.4, 'end_seconds': 1.6},
        {'id': 'w3', 'text': 'ending', 'start_seconds': 2.1, 'end_seconds': 2.7},
    ], 'segments': [{'word_ids': ['w1', 'w2', 'w3']}]}
    units = waveform_units(Path('unused'), transcript, 3)
    assert ' '.join(item['text'] for item in units) == 'Audible quiet ending'


def test_grounded_keep_explanations_are_retained_and_unknown_ids_fail(tmp_path):
    project(tmp_path)
    response = {'cuts': [], 'kept': [{'segment_id': 'segment_000001', 'reason': 'Introduces the recording.'}]}
    plan = build_plan(tmp_path, provider_factory=lambda *_: StubProvider(response))
    assert plan['decisions'][0]['reason'] == 'Introduces the recording.'
    response['kept'][0]['segment_id'] = 'invented'
    with pytest.raises(CleanerError, match='keep explanation'):
        build_plan(tmp_path, provider_factory=lambda *_: StubProvider(response))


def test_removing_all_speech_cannot_export_leftover_silence(tmp_path):
    project(tmp_path)
    plan = build_plan(tmp_path, provider_factory=lambda *_: StubProvider({'cuts': []}))
    for item in plan['decisions']:
        item['decision'] = 'cut'
    write_json(tmp_path / 'artifacts' / 'cleaner-plan.v1.json', plan)
    with pytest.raises(CleanerError, match='at least one speech'):
        render_plan(tmp_path)


def test_legacy_bad_timestamps_restore_implicit_gaps_and_block_export(tmp_path):
    project(tmp_path)
    build_plan(tmp_path, provider_factory=lambda *_: StubProvider({'cuts': []}))
    transcript_file = tmp_path / 'artifacts/transcript-artifact.v1.json'
    transcript = json.loads(transcript_file.read_text())
    transcript['words'] = [{'text': 'and', 'start_seconds': 1, 'end_seconds': 5}]
    write_json(transcript_file, transcript)
    plan = review_plan(tmp_path)
    assert plan['requires_reanalysis'] is True
    assert all(item['decision'] == 'keep' for item in plan['decisions'])
    with pytest.raises(CleanerError, match='Analyze again'):
        render_plan(tmp_path)
