"""Verbatim, local Cleaner transcription with independently decoded speech regions."""
from __future__ import annotations

import hashlib
import json
import re
from difflib import SequenceMatcher
from pathlib import Path

STRATEGY = "speech-regions-verbatim-v5"
ALIGNMENT_VERSION = "wav2vec2-ctc-v3"
ARTIFACT = Path("artifacts/cleaner-transcript.v1.json")


def split_retake_segments(segments, words):
    """Expose repeated suffixes and internal restarts without discarding any word."""
    by_id = {w['id']: w for w in words}
    selected = [[by_id[i] for i in s.get('word_ids', []) if i in by_id] for s in segments]
    tokens = [[re.sub(r'\W+', '', w['text'].lower()) for w in group] for group in selected]
    breaks = [{0, len(group)} for group in selected]
    for i, a in enumerate(tokens):
        # Even a two-word restart ("And remember") needs its own decision.
        for start in range(len(a)-3):
            for later in range(start+2, len(a)-1):
                if a[start:start+2] == a[later:later+2] and any(a[start:start+2]):
                    breaks[i].update([start, later])
                    break
        for j in range(i+1, min(len(tokens), i+13)):
            b = tokens[j]
            match = SequenceMatcher(None, a, b, autojunk=False).find_longest_match()
            if match.size < 3 or match.b > 2 or match.a == 0:
                continue
            start = match.a
            # Keep the unique lead-in; carry short delivery words with the retake.
            while start > max(0, match.a-3) and a[start-1] in {'you', 'just', 'simply', 'and', 'uh', 'um'}:
                start -= 1
            if start > 2:
                breaks[i].add(start)
    result = []
    for segment, group, boundaries in zip(segments, selected, breaks):
        if not group:
            result.append(dict(segment))
            continue
        ordered = sorted(boundaries)
        for start, end in zip(ordered, ordered[1:]):
            part = group[start:end]
            if not part:
                continue
            result.append({**segment, 'word_ids': [w['id'] for w in part],
                           'text': ' '.join(w['text'].strip() for w in part),
                           'start_seconds': part[0]['start_seconds'], 'end_seconds': part[-1]['end_seconds']})
    for index, segment in enumerate(result, 1):
        segment['id'] = f'segment_{index:06d}'
        for word_id in segment.get('word_ids', []):
            by_id[word_id]['segment_id'] = segment['id']
    return result


def uncovered_audio(audio, words):
    """Flag audible activity outside ASR coverage. This is NOT a cough classifier."""
    import numpy as np
    frame = 320  # 20 ms at 16 kHz
    count = len(audio)//frame
    if not count:
        return []
    rms = np.sqrt(np.mean(np.asarray(audio[:count*frame]).reshape(count, frame)**2, axis=1))
    threshold = max(.01, float(np.percentile(rms, 20))*4)
    active = rms > threshold
    # Join brief gaps inside a cough/noise burst, before masking recognized speech.
    indices = np.flatnonzero(active)
    for left, right in zip(indices, indices[1:]):
        if right-left <= 6:
            active[left:right] = True
    for word in words:
        start = max(0, int((word['start_seconds']-.12)*50))
        end = min(count, int((word['end_seconds']+.12)*50)+1)
        active[start:end] = False
    events, start = [], None
    for i, value in enumerate([*active, False]):
        if value and start is None:
            start = i
        elif not value and start is not None:
            if i-start >= 9:
                events.append({'start_seconds': start/50, 'end_seconds': i/50,
                    'message': 'Audible sound without recognized words: possible cough, breath, noise or missed speech. Listen and choose Remove or Keep.',
                    'kind': 'audio_event'})
            start = None
    return events


def quality_warnings(words):
    warnings = []
    for word in words:
        # start/end are edit boundaries and may deliberately include VAD padding
        # or half an inter-word gap. Only raw acoustic evidence can establish a
        # suspicious word duration.
        start = float(word.get('acoustic_start_seconds', word['start_seconds']))
        end = float(word.get('acoustic_end_seconds', word['end_seconds']))
        confidence = word.get('acoustic_confidence', word.get('confidence'))
        alignment = word.get('alignment_warning')
        if not alignment and end - start <= 1.0 and end > start and (confidence is None or confidence >= .15):
            continue
        warning = {
            'start_seconds': start,
            'end_seconds': end,
            'message': (alignment or {}).get('message', 'Uncertain word timing. Listen before removing this section.'),
            # A localized warning only invalidates edit boundaries touching this
            # word. Legacy warnings without this field retain their broad guard.
            # The outside of a complete padded speech region is independently
            # established by VAD, not by this word's CTC confidence. Interior
            # word joins still require acoustic evidence.
            'boundary_seconds': [float(word[f'{side}_seconds']) for side in ('start', 'end')
                                 if word.get(f'{side}_boundary_source') != 'speech_region'],
            'blocks_auto_cut': True,
        }
        if alignment:
            warning.update({'kind': 'alignment', 'failure_kind': alignment.get('kind', 'low_acoustic_confidence')})
        if not warning['boundary_seconds']:
            warning['blocks_auto_cut'] = False
        if word.get('id'):
            warning['word_ids'] = [word['id']]
        warnings.append(warning)
    return warnings


def cleaner_cache_key(fingerprint, model_name, language, *, alignment_version=ALIGNMENT_VERSION):
    return hashlib.sha256(json.dumps([STRATEGY, alignment_version, fingerprint, model_name, language]).encode()).hexdigest()


def recover_repeated_tail(model, audio, segment, offset, limit, language):
    """Recheck stretched word alignment with fresh suffix context, not invented text."""
    words = [{'word': w.word, 'start': offset+w.start, 'end': min(limit, offset+w.end),
              'probability': w.probability} for w in segment.words or []]
    token = lambda w: re.sub(r'\W+', '', w['word'].lower())
    vocabulary = {token(w) for w in words}
    # A bounded extra pass only for sparse/overstretched recognition.
    for index, word in enumerate(words[:-1]):
        if word['end']-word['start'] <= 1.0:
            continue
        boundary = word['end']
        if limit-boundary < .6:
            continue
        expected = [token(w) for w in words[index+1:]]
        best = []
        for shift in (0, .1):
            context_start = boundary+shift
            retry, _ = model.transcribe(audio[int(context_start*16000):int(limit*16000)],
                language=language, word_timestamps=True, condition_on_previous_text=False,
                beam_size=5, temperature=0)
            candidate = [{'word': w.word, 'start': context_start+w.start, 'end': min(limit,context_start+w.end),
                          'probability': w.probability} for s in retry for w in s.words or []]
            actual = [token(w) for w in candidate]
            matches = sum(m.size for m in SequenceMatcher(None, expected, actual, autojunk=False).get_matching_blocks())
            if (max(len(expected), len(best)) < len(actual) <= 2*len(expected)+2 and matches == len(expected)
                    and set(actual) <= vocabulary and candidate
                    and sum(w['probability'] for w in candidate)/len(candidate) >= .5
                    and all(w['end'] > w['start'] for w in candidate)):
                best = candidate
        if best:
            return words[:index+1] + best
        break
    return words


def decode_regions(model, audio, regions, language, progress=lambda _: None, aligner=None):
    """Offset each independently decoded region back onto the source timeline."""
    from .transcribe import normalize_segments
    raw, warnings = [], []
    for index, region in enumerate(regions):
        offset = region["start"] / 16000
        limit = region["end"] / 16000
        segments, _ = model.transcribe(
            audio[region["start"]:region["end"]], language=language,
            word_timestamps=True, condition_on_previous_text=False,
            beam_size=5, temperature=0,
            initial_prompt="Verbatim recording. Include every repeated word, repeated sentence, hesitation and false start.",
        )
        count = 0
        decoded = list(segments)
        groups = [recover_repeated_tail(model, audio, segment, offset, limit, language) for segment in decoded]
        complete = [word for group in groups for word in group]
        if complete and aligner is not None:
            try:
                aligned = aligner.align(audio, complete, offset, limit)
                cursor = 0
                for group_index, group in enumerate(groups):
                    groups[group_index] = aligned[cursor:cursor+len(group)]
                    cursor += len(group)
            except ValueError as error:
                warnings.append({'start_seconds':offset, 'end_seconds':limit,
                    'kind': 'alignment', 'failure_kind': getattr(error, 'kind', 'phrase_unalignable'),
                    'blocks_auto_cut': True,
                    'affected_word_indices': list(getattr(error, 'word_indices', range(len(complete)))),
                    'message':'Acoustic alignment could not verify this complete phrase. Timing is uncertain; no automatic removal is safe here.'})
        for segment_index, segment in enumerate(decoded):
            recovered = groups[segment_index]
            if recovered and max(w['probability'] for w in recovered) < .15:
                warnings.append({'start_seconds':offset, 'end_seconds':limit, 'kind':'audio_event',
                    'message':'The recognizer could not reliably identify words here. Possible cough, breath or missed speech; listen and choose Remove or Keep.'})
                count += 1
                continue
            # ASR frequently ends the last word early. Keep the complete detected
            # audio envelope, including its small safety pad, with the outer words.
            if recovered:
                if segment_index == 0:
                    recovered[0]['start'] = min(offset, recovered[0]['start'])
                    if 'acoustic_start' in recovered[0]:
                        recovered[0]['start_boundary_source'] = 'speech_region'
                if segment_index == len(decoded)-1:
                    recovered[-1]['end'] = max(limit, recovered[-1]['end'])
                    if 'acoustic_end' in recovered[-1]:
                        recovered[-1]['end_boundary_source'] = 'speech_region'
            raw.append({
                "start": offset + segment.start, "end": min(limit, offset + segment.end),
                "text": ' '.join(w['word'].strip() for w in recovered) if recovered else segment.text,
                "avg_logprob": segment.avg_logprob,
                "words": recovered,
            })
            count += 1
        if not count:
            warnings.append({"start_seconds": offset, "end_seconds": limit,
                             "message": "Speech was detected here but no words were recognized. Review the original audio."})
        progress({"phase": "verbatim_transcription", "fraction": (index + 1) / max(1, len(regions)),
                  "message": f"Preserving takes: speech region {index + 1} of {len(regions)}"})
    segments, words = normalize_segments(raw, duration_seconds=len(audio) / 16000)
    evidence = [word for segment in raw for word in segment.get('words') or []]
    if len(evidence) == len(words):
        for word, source in zip(words, evidence):
            if 'acoustic_start' in source:
                word['acoustic_start_seconds'] = source['acoustic_start']
                word['acoustic_end_seconds'] = source['acoustic_end']
                word['acoustic_confidence'] = source['acoustic_confidence']
            if source.get('alignment_warning'):
                word['alignment_warning'] = source['alignment_warning']
            for side in ('start', 'end'):
                if source.get(f'{side}_boundary_source'):
                    word[f'{side}_boundary_source'] = source[f'{side}_boundary_source']
    return segments, words, warnings + quality_warnings(words)


def prepare_transcript(project_dir: Path, model_cache=None, progress=lambda _: None):
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import get_speech_timestamps, VadOptions
    from .cleaner import _read_json, _atomic_json, CleanerError
    from .transcribe import inspect_model, resolve_model_cache, _default_model_open
    from .ingest import fingerprint_file

    project_dir = project_dir.expanduser().resolve()
    base = _read_json(project_dir / "artifacts/transcript-artifact.v1.json")
    manifest = _read_json(project_dir / "cleaner.json")
    source = Path(manifest["source"]["uri"]).expanduser().resolve()
    fingerprint = fingerprint_file(source)
    if fingerprint != base["source"]["fingerprint"]:
        raise CleanerError("The recording changed since transcription. Create a new project for the changed recording.")
    name = base["transcription"]["model"]
    language = base["transcription"].get("detected_language")
    identity = cleaner_cache_key(fingerprint, name, language)
    try:
        previous = _read_json(project_dir / ARTIFACT)
        if previous.get("cleaner_cache_key") == identity:
            return previous
    except CleanerError:
        pass
    readiness = inspect_model(name, resolve_model_cache(override=model_cache))
    if not readiness["model_ready"]:
        raise CleanerError(readiness["message"])
    progress({"phase": "verbatim_transcription", "fraction": 0, "message": "Reading speech regions locally; keeping repetitions and false starts"})
    audio = decode_audio(str(source), sampling_rate=16000)
    regions = get_speech_timestamps(audio, VadOptions(
        threshold=0.3, min_silence_duration_ms=350, speech_pad_ms=150, max_speech_duration_s=8,
    ))
    if not regions:
        raise CleanerError("No speech regions could be verified. Check the recording's audio before analysis.")
    model = _default_model_open(Path(readiness["model_path"]), device="cpu", compute_type="int8")
    aligner = None
    if language == 'en':
        from .cleaner_align import AcousticAligner
        try:
            aligner = AcousticAligner(readiness['model_path'])
        except (ImportError, OSError, ValueError) as error:
            raise CleanerError(f'Local acoustic alignment is unavailable: {error}') from error
    segments, words, warnings = decode_regions(model, audio, regions, language, progress, aligner=aligner)
    if not segments:
        raise CleanerError("Speech was detected but transcription returned no words. Review the source audio.")
    if fingerprint_file(source) != fingerprint:
        raise CleanerError("The recording changed during transcription. Retry with a stable source file.")
    warnings += uncovered_audio(audio, words)
    segments = split_retake_segments(segments, words)
    result = {**base, "segments": segments, "words": words, "cleaner_strategy": STRATEGY,
              "cleaner_cache_key": identity, "quality_warnings": warnings,
              "cleaner_alignment": ALIGNMENT_VERSION if aligner else None,
              "transcription": {**base["transcription"], "cleaner_strategy": STRATEGY}}
    _atomic_json(project_dir / ARTIFACT, result)
    return result
