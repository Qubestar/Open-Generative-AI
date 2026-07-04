#!/usr/bin/env python3
"""
detect_beats.py — find the natural pauses in a voiceover and cut it into "beats".

Implements the golden rule from the reference tutorial: VOICEOVER FIRST, SCENE SECOND.
Each beat = one on-screen image. Beat boundaries land on natural pauses so every image
change lands on a breath, giving the video its "rhythm".

Pipeline:
    voiceover.wav --(faster-whisper word timestamps)--> words
                  --(gap > pause_gap)--> beat boundaries
                  --(cap any beat at max_len, also split very long ones)-->
    beats.json  (idx, start, end, dur, text, image_prompt:"")

Usage:
    .venv/bin/python detect_beats.py <voiceover.wav> <beats.json>
        [--pause-gap 0.35] [--max-len 6.0] [--min-len 1.2] [--model base.en]

Then a human/LLM fills "image_prompt" for each beat, generates the images in Higgsfield
named s001.png, s002.png ... (matching idx), and assemble.py stitches them to the audio.
"""
import argparse, json, sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("out_json")
    ap.add_argument("--pause-gap", type=float, default=0.35,
                    help="silence (s) between words that counts as a scene-change pause")
    ap.add_argument("--max-len", type=float, default=6.0,
                    help="hard cap on a beat; longer beats get split so no image sits too long")
    ap.add_argument("--min-len", type=float, default=1.2,
                    help="merge a beat shorter than this into the previous one")
    ap.add_argument("--model", default="base.en")
    args = ap.parse_args()

    from faster_whisper import WhisperModel

    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    segments, info = model.transcribe(args.wav, word_timestamps=True, vad_filter=True)

    words = []
    for seg in segments:
        for w in (seg.words or []):
            words.append({"t0": w.start, "t1": w.end, "w": w.word})
    if not words:
        sys.exit("no words transcribed — check the audio file")

    # 1) cut on natural pauses
    raw = []
    cur = [words[0]]
    for prev, nxt in zip(words, words[1:]):
        gap = nxt["t0"] - prev["t1"]
        if gap >= args.pause_gap:
            raw.append(cur)
            cur = [nxt]
        else:
            cur.append(nxt)
    raw.append(cur)

    # 2) split beats longer than max_len at the widest internal gap (repeatedly)
    def split_long(group):
        dur = group[-1]["t1"] - group[0]["t0"]
        if dur <= args.max_len or len(group) < 2:
            return [group]
        # find widest gap
        best_i, best_gap = 1, -1
        for i in range(1, len(group)):
            g = group[i]["t0"] - group[i - 1]["t1"]
            if g > best_gap:
                best_gap, best_i = g, i
        return split_long(group[:best_i]) + split_long(group[best_i:])

    split = []
    for g in raw:
        split.extend(split_long(g))

    # 3) merge too-short beats forward into previous
    merged = []
    for g in split:
        dur = g[-1]["t1"] - g[0]["t0"]
        if merged and dur < args.min_len:
            merged[-1].extend(g)
        else:
            merged.append(g)

    beats = []
    for i, g in enumerate(merged, 1):
        start = round(g[0]["t0"], 2)
        end = round(g[-1]["t1"], 2)
        text = "".join(x["w"] for x in g).strip()
        beats.append({
            "idx": i,
            "id": f"s{i:03d}",
            "start": start,
            "end": end,
            "dur": round(end - start, 2),
            "text": text,
            "image_prompt": "",
        })

    json.dump({"audio": args.wav, "beats": beats}, open(args.out_json, "w"), indent=2)
    total = beats[-1]["end"]
    print(f"{len(beats)} beats over {total:0.1f}s "
          f"(avg {total/len(beats):0.1f}s/beat) -> {args.out_json}")


if __name__ == "__main__":
    main()
