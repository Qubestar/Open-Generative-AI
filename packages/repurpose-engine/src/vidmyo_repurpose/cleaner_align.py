"""Offline acoustic word alignment. Whisper supplies text, not edit boundaries.

The independently trained Apache-2.0 wav2vec2 English model supplies CTC
emissions. Standard CTC Viterbi decoding pins the complete recovered phrase to
the audio together, so repeated words cannot inherit a suffix decoder's clock.
"""
from pathlib import Path
import re
import numpy as np

MODEL = 'facebook/wav2vec2-base-960h'
REVISION = '22aad52d435eb6dbaf354bdad9b0da84ce7d6156'


class AlignmentFailure(ValueError):
    """A typed alignment failure that callers can surface without guessing."""

    def __init__(self, kind, message, *, word_indices=()):
        super().__init__(message)
        self.kind = str(kind)
        self.word_indices = tuple(int(index) for index in word_indices)

def ctc_spans(emissions, tokens, blank):
    """Return frame spans for every target token, or reject an impossible path."""
    if not tokens or not len(emissions):
        raise ValueError('Empty alignment')
    labels = np.array([blank, *[value for token in tokens for value in (token, blank)]])
    size = len(labels)
    scores = np.full(size, -np.inf)
    scores[0] = 0
    back = np.zeros((len(emissions), size), dtype=np.int32)
    forbidden = (labels == blank) | (labels == np.roll(labels, 2))
    for frame, row in enumerate(emissions):
        options = np.stack([scores, np.r_[-np.inf, scores[:-1]], np.r_[[-np.inf]*2, scores[:-2]]])
        options[2, forbidden] = -np.inf
        back[frame] = np.arange(size) - options.argmax(axis=0)
        scores = options.max(axis=0) + row[labels]
    state = size-1 if scores[-1] > scores[-2] else size-2
    if not np.isfinite(scores[state]):
        raise ValueError('Audio cannot support every transcript character')
    states = np.empty(len(emissions), dtype=np.int32)
    for frame in range(len(emissions)-1, -1, -1):
        states[frame] = state
        state = back[frame, state]
    spans = []
    for index, token in enumerate(tokens):
        frames = np.flatnonzero(states == index*2+1)
        if not len(frames):
            raise ValueError('Unaligned transcript character')
        spans.append((int(frames[0]), int(frames[-1]+1), float(np.exp(emissions[frames, token]).mean())))
    return spans


def aligned_words(words, normalized, spans, offset, limit, frame_seconds):
    """Keep acoustic evidence separate from edit boundaries and padding."""
    aligned, cursor = [], 0
    for word_index, (original, word) in enumerate(zip(words, normalized)):
        selected = spans[cursor:cursor+len(word)]
        if len(selected) != len(word):
            raise AlignmentFailure('word_unaligned', 'A transcript word could not be aligned', word_indices=(word_index,))
        confidence = float(np.mean([span[2] for span in selected]))
        acoustic_start = offset + selected[0][0] * frame_seconds
        acoustic_end = min(limit, offset + selected[-1][1] * frame_seconds)
        item = {
            **original,
            'start': acoustic_start,
            'end': acoustic_end,
            'probability': confidence,
            'acoustic_start': acoustic_start,
            'acoustic_end': acoustic_end,
            'acoustic_confidence': confidence,
        }
        if confidence < .55 or min(span[2] for span in selected) < .02:
            item['alignment_warning'] = {
                'kind': 'low_acoustic_confidence',
                'message': 'Acoustic evidence is weak for this word. Listen before using either adjacent cut boundary.',
            }
        aligned.append(item)
        cursor += len(word) + 1
    # The edit clock assigns every inter-word sample to one side of a cut. The
    # acoustic clock above remains untouched for quality assessment.
    for left, right in zip(aligned, aligned[1:]):
        boundary = round((left['acoustic_end'] + right['acoustic_start']) / 2, 4)
        left['end'] = right['start'] = boundary
    return aligned


class AcousticAligner:
    def __init__(self, whisper_model_path):
        from huggingface_hub import try_to_load_from_cache
        from huggingface_hub.constants import HF_HUB_CACHE
        import torch
        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor
        roots = [Path(HF_HUB_CACHE), *Path(whisper_model_path).parents]
        model_path = None
        for root in roots:
            cached = try_to_load_from_cache(MODEL, 'model.safetensors', revision=REVISION, cache_dir=str(root))
            if isinstance(cached, str):
                model_path = str(Path(cached).parent)
                break
        if not model_path:
            raise ValueError('Cleaner needs the local English acoustic alignment model. See the Cleaner alignment setup in the engine README. No recording was uploaded.')
        self.torch = torch
        self.processor = Wav2Vec2Processor.from_pretrained(model_path, local_files_only=True)
        self.model = Wav2Vec2ForCTC.from_pretrained(model_path, local_files_only=True, use_safetensors=True).eval()
        self.frame_seconds = self.model.config.inputs_to_logits_ratio / 16000

    def align(self, audio, words, offset, limit):
        normalized = [re.sub("[^A-Z']", '', word['word'].upper()) for word in words]
        unsupported = [index for index, word in enumerate(normalized) if not word]
        if unsupported:
            raise AlignmentFailure('unsupported_word', 'Unsupported word characters', word_indices=unsupported)
        text = ' '.join(normalized)
        tokens = self.processor.tokenizer(text).input_ids
        if self.processor.tokenizer.unk_token_id in tokens:
            raise AlignmentFailure('unsupported_token', 'Unsupported alignment token', word_indices=range(len(words)))
        sample = audio[int(offset*16000):int(limit*16000)]
        inputs = self.processor(sample, sampling_rate=16000, return_tensors='pt')
        with self.torch.inference_mode():
            logits = self.model(**inputs).logits[0].log_softmax(-1).cpu().numpy()
        try:
            spans = ctc_spans(logits, tokens, self.processor.tokenizer.pad_token_id)
        except ValueError as error:
            raise AlignmentFailure('phrase_unalignable', str(error), word_indices=range(len(words))) from error
        return aligned_words(words, normalized, spans, offset, limit, self.frame_seconds)
