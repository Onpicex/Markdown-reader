#!/usr/bin/env python3
"""Transcribe one audio file with Qwen3-ASR-1.7B (MLX, 8bit) and write a
natural-segmented WebVTT. Replaces the old mlx_whisper path (2026-06-20):
whisper-turbo hallucinated fabricated ad text / repetition loops on long
Chinese lectures; Qwen is hallucination-free and ~4x faster than fp16.

Usage:  qwen_vtt.py <audio> <out.vtt>
Env:    QWEN_ASR_BIN    path to the mlx-qwen3-asr executable (its own venv)
        QWEN_ASR_MODEL  default mlx-community/Qwen3-ASR-1.7B-8bit

Runs under any python3 (stdlib only); shells out to the venv's mlx-qwen3-asr
for the ASR + forced-aligner, then does per-chunk punctuation merge + cue
grouping here. Transcribes into a private temp dir to dodge mlx output-name
multi-dot truncation, so the caller's output path is honored verbatim.
"""
import sys, os, re, json, subprocess, tempfile, glob

QASR  = os.environ.get("QWEN_ASR_BIN", "mlx-qwen3-asr")
MODEL = os.environ.get("QWEN_ASR_MODEL", "mlx-community/Qwen3-ASR-1.7B-8bit")

SENT_END = set("。！？!?…")
CLAUSE   = set("，、；：,;:")
MIN_CLAUSE = 8
MAX_CHARS  = 22
MAX_GAP    = 1.0
MAX_DUR    = 7.0
PUNCT_ALL  = set("。，、；：！？…!?,;:.“”‘’《》〈〉()（）「」『』【】—–~·\"' \t\n")

def _is_punct(c): return c.isspace() or c in PUNCT_ALL

def merge_per_chunk(data):
    """Attach punctuation from each chunk's text onto that chunk's word-segments.
    Per-chunk reset => any text/segment char mismatch stays local (no global drift)."""
    text = data.get("text", "")
    segs = data.get("segments") or []
    chunks = data.get("chunks") or []
    if not chunks:
        chunks = [{"text": text,
                   "start": segs[0]["start"] if segs else 0.0,
                   "end":   segs[-1]["end"] if segs else 0.0}]
    toks, si, nseg = [], 0, len(segs)
    for ci, ch in enumerate(chunks):
        cend = float(ch["end"]); is_last = (ci == len(chunks) - 1)
        cseg = []
        while si < nseg and (is_last or float(segs[si]["start"]) < cend - 1e-6):
            cseg.append(segs[si]); si += 1
        k = 0; local_start = len(toks)
        for c in ch.get("text", ""):
            if _is_punct(c):
                if len(toks) > local_start: toks[-1]["text"] += c
                continue
            if k < len(cseg):
                s = cseg[k]; k += 1
                toks.append({"text": c, "start": float(s["start"]), "end": float(s["end"])})
            elif len(toks) > local_start:
                toks[-1]["text"] += c
        if k < len(cseg) and toks:
            toks[-1]["end"] = float(cseg[-1]["end"])
    return toks

def regroup(toks):
    cues, cur = [], []
    def txt(): return "".join(t["text"] for t in cur)
    def flush():
        if not cur: return
        t = txt().strip()
        if t: cues.append({"start": cur[0]["start"], "end": cur[-1]["end"], "text": t})
        cur.clear()
    for tk in toks:
        if cur:
            gap = tk["start"] - cur[-1]["end"]; dur = tk["end"] - cur[0]["start"]
            if gap >= MAX_GAP or dur > MAX_DUR or len(txt()) >= MAX_CHARS:
                flush()
        cur.append(tk)
        last = tk["text"][-1] if tk["text"] else ""
        cl = txt()
        if last in SENT_END: flush()
        elif last in CLAUSE and len(cl) >= MIN_CLAUSE: flush()
    flush()
    return cues

def _fmt(ts):
    h=int(ts//3600); m=int((ts%3600)//60); s=ts%60
    return f"{h:02d}:{m:02d}:{s:06.3f}"

def _apply_hotwords(cues, audio_path):
    """Optional hotwords.json next to this script (gitignored; see
    hotwords.example.json): course-scoped ASR homophone fixes baked into the
    VTT at transcription time so every downstream consumer sees clean text.
    Course keys match by substring of the audio path."""
    try:
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hotwords.json")
        with open(p, encoding="utf-8") as f:
            hw = json.load(f)
    except Exception:
        return cues
    pairs = list(hw.get("global") or [])
    for course, extra in (hw.get("courses") or {}).items():
        if course and course in audio_path:
            pairs.extend(extra or [])
    for c in cues:
        for pair in pairs:
            try:
                if pair[0] and isinstance(pair[0], str) and isinstance(pair[1], str):
                    c["text"] = c["text"].replace(pair[0], pair[1])
            except Exception:
                continue
    return cues

def main():
    if len(sys.argv) < 3:
        print("usage: qwen_vtt.py <audio> <out.vtt>", file=sys.stderr); sys.exit(2)
    audio, out_vtt = sys.argv[1], sys.argv[2]
    with tempfile.TemporaryDirectory() as td:
        r = subprocess.run([QASR, audio, "--model", MODEL, "--language", "Chinese",
                            "-f", "json", "--timestamps", "-o", td, "--no-progress"],
                           capture_output=True, text=True)
        if r.returncode != 0:
            sys.stderr.write((r.stderr or "")[-800:]); sys.exit(r.returncode or 1)
        js = glob.glob(os.path.join(td, "*.json"))
        if not js:
            print("qwen_vtt: no json produced", file=sys.stderr); sys.exit(3)
        data = json.load(open(js[0], encoding="utf-8"))
    cues = _apply_hotwords(regroup(merge_per_chunk(data)), audio)
    if not cues:
        print("qwen_vtt: empty transcript", file=sys.stderr); sys.exit(4)
    with open(out_vtt, "w", encoding="utf-8") as f:
        # The NOTE line marks engine provenance: server.js treats VTTs without
        # it as legacy (whisper-era) and offers/queues re-transcription.
        f.write("WEBVTT\n\nNOTE transcriber: qwen3-asr (" + MODEL + ")\n\n")
        for c in cues:
            f.write(f"{_fmt(c['start'])} --> {_fmt(c['end'])}\n{c['text']}\n\n")

if __name__ == "__main__":
    main()
