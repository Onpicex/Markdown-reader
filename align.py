#!/usr/bin/env python3
"""
Semantic alignment: match VTT cues to article paragraphs using embedding similarity.
Usage: python3 align.py [--segments segs.json] <article_path> <vtt_path> [output_json_path]
       python3 align.py --daemon    (JSON-lines server on stdin/stdout; model loaded once)
Outputs JSON: { segMap: number[], segTimeRanges: {start,end}[], stats: {...} }
"""
import sys, json, re, time, os, hashlib
from collections import Counter
import numpy as np

def _load_align_version():
    """Single source of truth shared with server.js (align-version.json).
    Bump there once; both sides pick it up. Falls back to a literal if the
    file is missing/corrupt so alignment never breaks on a bad deploy."""
    try:
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'align-version.json')
        with open(p, 'r', encoding='utf-8') as f:
            return int(json.load(f).get('version', 14))
    except Exception:
        return 14

ALIGN_VERSION = _load_align_version()

def _load_hotwords():
    """Optional hotwords.json next to this script: course-scoped ASR homophone
    fixes applied to the raw VTT text before parsing (e.g. \u96c4\u5f02\u2192\u718a\u9038).
    { "global": [["wrong","right"],...], "courses": {"<dir-name>": [[..],..]} }
    The real file is gitignored (contains course names); see hotwords.example.json."""
    try:
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'hotwords.json')
        with open(p, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}

def apply_hotwords(vtt_text, vtt_path):
    hw = _load_hotwords()
    pairs = list(hw.get('global') or [])
    for course, extra in (hw.get('courses') or {}).items():
        if course and course in (vtt_path or ''):
            pairs.extend(extra or [])
    for pair in pairs:
        try:
            wrong, right = pair[0], pair[1]
            if wrong and isinstance(wrong, str) and isinstance(right, str):
                vtt_text = vtt_text.replace(wrong, right)
        except Exception:
            continue
    return vtt_text

def norm_text(t):
    """Strip whitespace and punctuation for comparison."""
    t = re.sub(r'[\s\u3000\u00A0]', '', t)
    t = re.sub(r'[^\u4e00-\u9fff\u3400-\u4dbfa-zA-Z0-9]', '', t)
    return t.lower()

# \u2500\u2500 Pinyin-normalized similarity (ASR homophone robustness) \u2500\u2500
# Whisper-era VTTs are full of same-sound-wrong-char errors (\u96c4\u5f02/\u718a\u9038,
# \u5f17\u5b66/\u4f5b\u5b66) that score 0.0 on any character-level comparison. Normalizing
# both sides to toneless pinyin recovers the match (xiong yi == xiong yi).
# pypinyin is optional \u2014 without it everything degrades to char-only exactly
# as before.
try:
    from pypinyin import lazy_pinyin as _lazy_pinyin
except Exception:
    _lazy_pinyin = None

_pinyin_cache = {}

_CN_DIGITS = '\u96f6\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d'

def _digits_to_cn(m):
    """Read small integers the way a narrator would (50\u2192\u4e94\u5341, 100\u2192\u4e00\u767e) so
    '\u4f5b\u5b6650\u8bb2' pinyin-matches spoken '\u4f5b\u5b66\u4e94\u5341\u8bb2'. Longer runs fall back to
    digit-by-digit reading (2026\u2192\u4e8c\u96f6\u4e8c\u516d), matching common narration."""
    s = m.group(0)
    n = int(s)
    if 10 <= n <= 99:
        tens, ones = divmod(n, 10)
        out = (_CN_DIGITS[tens] if tens > 1 else '') + '\u5341'
        return out + (_CN_DIGITS[ones] if ones else '')
    if 100 <= n <= 999 and n % 100 == 0:
        return _CN_DIGITS[n // 100] + '\u767e'
    return ''.join(_CN_DIGITS[int(c)] for c in s)

def _pinyin_tokens(t):
    """norm_text \u2192 tuple of toneless pinyin syllables (non-CJK chars kept as-is)."""
    nt = norm_text(t)
    if not nt:
        return ()
    hit = _pinyin_cache.get(nt)
    if hit is not None:
        return hit
    toks = tuple(_lazy_pinyin(re.sub(r'\d+', _digits_to_cn, nt)))
    if len(_pinyin_cache) > 20000:
        _pinyin_cache.clear()
    _pinyin_cache[nt] = toks
    return toks

def pinyin_similarity(a, b):
    """Token-bag overlap on toneless pinyin (mirrors char_similarity's
    Counter-bag semantics). 0.0 when pypinyin is unavailable."""
    if _lazy_pinyin is None:
        return 0.0
    ta, tb = _pinyin_tokens(a), _pinyin_tokens(b)
    if not ta or not tb:
        return 0.0
    if len(ta) > 200 or len(tb) > 200:
        ta, tb = ta[:200], tb[:200]
    shorter, longer = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
    if len(longer) > len(shorter) * 3:
        cs = Counter(shorter)
        best = 0.0
        step = max(1, len(shorter) // 2)
        for start in range(0, len(longer) - len(shorter) + 1, step):
            window = longer[start:start + len(shorter) + len(shorter) // 2]
            common = sum((cs & Counter(window)).values())
            best = max(best, common / max(len(shorter), 1))
        return best
    ca, cb = Counter(ta), Counter(tb)
    common = sum((ca & cb).values())
    return 2 * common / (len(ta) + len(tb))

def _pinyin_substr(needle, hay):
    """Pinyin-level substring test for very short targets (headings, \u5bf9\u8bdd lines):
    '\u96c4\u9038' contains '\u718a\u9038' at the sound level."""
    if _lazy_pinyin is None:
        return False
    tn, th = _pinyin_tokens(needle), _pinyin_tokens(hay)
    if not tn or not th or len(tn) > len(th):
        return False
    for i in range(len(th) - len(tn) + 1):
        if th[i:i + len(tn)] == tn:
            return True
    return False

def char_similarity_ex(a, b):
    """max(char-bag, pinyin-bag) similarity \u2014 the drop-in used by all the
    hard-threshold passes so ASR homophones stop scoring zero."""
    cs = char_similarity(a, b)
    if cs >= 0.9:
        return cs
    return max(cs, pinyin_similarity(a, b))

def _strip_md_emphasis(s):
    """Strip markdown emphasis/links so text matches the rendered DOM textContent.
    Order matters: strong first (** **) before emphasis (* *)."""
    s = re.sub(r'\*\*(.+?)\*\*', r'\1', s)
    s = re.sub(r'__(.+?)__', r'\1', s)
    s = re.sub(r'(?<!\*)\*([^\*\n]+?)\*(?!\*)', r'\1', s)
    s = re.sub(r'(?<![\w_])_([^_\n]+?)_(?![\w_])', r'\1', s)
    s = re.sub(r'`([^`]+?)`', r'\1', s)
    # Inline image ![alt](url) → alt
    s = re.sub(r'!\[([^\]]*?)\]\([^\)]+?\)', r'\1', s)
    # Link [text](url) → text
    s = re.sub(r'\[([^\]]+?)\]\([^\)]+?\)', r'\1', s)
    # Wikilinks [[X|Y]] → Y, [[X]] → X
    s = re.sub(r'\[\[([^\]\|]+?)\|([^\]]+?)\]\]', r'\2', s)
    s = re.sub(r'\[\[([^\]]+?)\]\]', r'\1', s)
    return s


def parse_segments(md_text):
    """Extract paragraphs matching the browser DOM after marked.parse().

    Frontend selector: 'p, h1-h6, li, blockquote > p, td, th'; .audio-embed skipped;
    empty textContent skipped. We must match its segment COUNT exactly or the
    frontend rejects our alignment and falls back to LCS.
    """
    # YAML frontmatter: front-end `stripFrontmatter` removes it entirely before
    # marked.parse, so it does NOT appear as a DOM segment. Match that here.
    # Logic mirrors dist/index.html stripFrontmatter(): requires leading '---'
    # and a subsequent '\n---\s*\n' delimiter.
    if md_text.startswith('---'):
        m = re.search(r'\n---\s*\n', md_text[3:])
        md_body = md_text[3 + m.end():] if m else md_text
    else:
        md_body = md_text
    # Remove audio/video embed lines (rendered as <div class="audio-embed">, skipped)
    md_body = re.sub(
        r'^\s*!\[\[[^\]]+?\.(mp3|wav|m4a|ogg|mp4|webm)(\|[^\]]*?)?\]\]\s*$',
        '', md_body, flags=re.MULTILINE | re.IGNORECASE)
    # Remove Obsidian IMAGE wikilink embeds ![[img.jpg]] — the frontend's
    # convertWikiLinks() turns these into ![](...) → <p><img></p> with empty
    # textContent, which collectArticleSegments() then skips. align.py must skip
    # them too, or its segment COUNT won't match the DOM and the frontend
    # silently rejects this alignment and falls back to LCS (see parse_segments
    # docstring). Extensions mirror convertWikiLinks (jpg/jpeg/png/gif/webp/svg/bmp).
    md_body = re.sub(
        r'^\s*!\[\[[^\]]+?\.(jpg|jpeg|png|gif|webp|svg|bmp)(\|[^\]]*?)?\]\]\s*$',
        '', md_body, flags=re.MULTILINE | re.IGNORECASE)

    blocks = re.split(r'\n\n+', md_body.strip())

    segments = []
    for block in blocks:
        block = block.strip()
        if not block:
            continue

        # If the block's first line is a horizontal rule (not a Setext underline,
        # since no preceding paragraph line in this block), drop it and continue
        # processing the rest. Handles platform trailing "---\n_抓取时间..._".
        lines = block.split('\n')
        if len(lines) > 1 and re.fullmatch(r'-{3,}|\*{3,}|_{3,}', lines[0].strip()):
            block = '\n'.join(lines[1:]).strip()
            if not block:
                continue

        # Horizontal rule (rendered as <hr>, not in selector)
        if re.fullmatch(r'(-{3,}|\*{3,}|_{3,})', block):
            continue

        # Standalone image block ![alt](url) → <p><img></p>, textContent="" → skipped
        if re.fullmatch(r'!\[[^\]]*?\]\([^\)]+?\)', block):
            continue

        # Heading
        if re.match(r'^#{1,6}\s+', block):
            text = re.sub(r'^#{1,6}\s+', '', block).strip()
            text = _strip_md_emphasis(text)
            if text:
                segments.append(text)
            continue

        # Blockquote: every line starts with '>'. Marked renders nested paragraphs
        # (separated by blank '>' lines) as multiple <p> children → multiple segments.
        block_lines = block.split('\n')
        if block_lines and all(re.match(r'^>\s*', l) for l in block_lines):
            inner = '\n'.join(re.sub(r'^>\s?', '', l) for l in block_lines)
            for sub in re.split(r'\n\s*\n+', inner.strip()):
                joined = ' '.join(l.strip() for l in sub.split('\n') if l.strip())
                text = _strip_md_emphasis(joined).strip()
                if text:
                    segments.append(text)
            continue

        # Ordered list
        ol_items = re.findall(r'^\d+\.\s+(.*)', block, re.MULTILINE)
        if ol_items:
            total = [l.strip() for l in block.split('\n') if l.strip()]
            if len(ol_items) >= len(total) * 0.5:
                for item in ol_items:
                    text = _strip_md_emphasis(item.strip())
                    if text:
                        segments.append(text)
                continue

        # Unordered list
        ul_items = re.findall(r'^[-*]\s+(.*)', block, re.MULTILINE)
        if ul_items:
            total = [l.strip() for l in block.split('\n') if l.strip()]
            if len(ul_items) >= len(total) * 0.5:
                for item in ul_items:
                    text = _strip_md_emphasis(item.strip())
                    if text:
                        segments.append(text)
                continue

        # Regular paragraph
        text = ' '.join(l.strip() for l in block.split('\n') if l.strip())
        text = _strip_md_emphasis(text)
        if text:
            segments.append(text)

    return segments

def parse_vtt(vtt_text):
    """Parse WebVTT into list of {start, end, text}."""
    cues = []
    for block in re.split(r'\n\n+', vtt_text):
        lines = block.strip().split('\n')
        for i, line in enumerate(lines):
            m = re.match(r'([\d:.,]+)\s*-->\s*([\d:.,]+)', line)
            if m:
                start = parse_time(m.group(1))
                end = parse_time(m.group(2))
                text = ' '.join(l.strip() for l in lines[i+1:] if l.strip())
                if text:
                    cues.append({'start': start, 'end': end, 'text': text})
    # Drop ASR hallucination cues, but ONLY at file boundaries.
    # mlx-whisper emits long low-rate cues over intro music / outro silence.
    # In the middle of a file, a low-rate long cue is usually a source-VTT
    # placeholder/summary (e.g. platform official transcripts may use one line
    # like "对话" to summarize a multi-line dialogue) — dropping it leaves a
    # gap and confuses the aligner.
    def _is_hallucination(c):
        dur = c['end'] - c['start']
        if dur <= 8:
            return False
        rate = len(norm_text(c['text'])) / max(dur, 0.1)
        return rate < 1.0
    while len(cues) > 1 and _is_hallucination(cues[0]):
        cues.pop(0)
    while len(cues) > 1 and _is_hallucination(cues[-1]):
        cues.pop()
    # Drop low-unique-char repetition cues anywhere in the file (whisper-turbo
    # failure mode: "划划划划划划划划" repeating for many short cues when
    # transcribing music or stuck on a loop). These match nothing in the
    # article and pollute embedding alignment. Thresholds: a single char
    # repeated ≥4 times, or ≤2 unique chars at length ≥6 — length 4-5 with two
    # unique chars is spared because that's exactly the shape of legitimate
    # AABB reduplication words ("分分合合", "开开心心").
    def _is_low_unique(c):
        nt = norm_text(c['text'])
        u = len(set(nt))
        return (u == 1 and len(nt) >= 4) or (u <= 2 and len(nt) >= 6)
    cues = [c for c in cues if not _is_low_unique(c)]
    # Collapse cross-cue repetition loops (whisper failure mode the in-cue
    # trimmer below can't see): runs of consecutive cues drawn from ≤2 distinct
    # normalized texts, e.g. A/B/A/B/A… or A/A/A…, each text ≥2 chars, run ≥4
    # cues. Real speech never repeats the same clause verbatim 4+ times in a
    # row; keep the first occurrence of each distinct text and drop the rest,
    # so the aligner sees the content once instead of a 10-second echo wall.
    if len(cues) >= 4:
        cleaned = []
        i = 0
        while i < len(cues):
            ni = norm_text(cues[i]['text'])
            if len(ni) < 2:
                cleaned.append(cues[i])
                i += 1
                continue
            j = i
            texts = set()
            while j < len(cues):
                nj = norm_text(cues[j]['text'])
                if len(nj) < 2:
                    break
                if nj not in texts and len(texts) >= 2:
                    break
                texts.add(nj)
                j += 1
            run_len = j - i
            if run_len >= 4 and len(texts) <= 2:
                kept_texts = set()
                for k in range(i, j):
                    nk = norm_text(cues[k]['text'])
                    if nk not in kept_texts:
                        kept_texts.add(nk)
                        cleaned.append(cues[k])
                i = j
            else:
                cleaned.append(cues[i])
                i += 1
        cues = cleaned
    # Trim within-cue repetition-loop hallucinations (mlx-whisper-turbo's
    # signature failure mode). Example real case: a 30s cue whose tail is
    # "一百一百一百…" × 78. Without trimming, align.py expands the
    # corresponding article segment's time range to swallow the inflated
    # duration, freezing the highlight for the whole cue. Detection: any cue
    # ≥5s whose dominant 1- to 3-gram suffix repeats ≥5 times in a row.
    # On detection: strip the repeating tail from text and shrink end time
    # proportionally to the surviving character count (Whisper's timestamp
    # was inflated by the spurious repetition).
    for c in cues:
        dur = c['end'] - c['start']
        if dur < 5:
            continue
        norm = norm_text(c['text'])
        if len(norm) < 20:
            continue
        # Find longest periodic suffix among 1- to 3-gram periods.
        # Prefer larger ngrams when tied so "一百一百…" is detected as
        # period-2, not period-1 ("百百百…").
        best_cut = None  # char position in `norm` at which to cut
        best_repeats = 0
        for n in (3, 2, 1):
            if len(norm) < n * 5:
                continue
            suffix = norm[-n:]
            repeats = 1
            i = len(norm) - 2 * n
            while i >= 0 and norm[i:i + n] == suffix:
                repeats += 1
                i -= n
            if repeats >= 5 and repeats > best_repeats:
                best_repeats = repeats
                # Keep one occurrence of the ngram; drop the rest.
                best_cut = i + n + n  # = (last non-repeating end) + 1 ngram
        if best_cut is None or best_cut >= len(norm):
            continue
        retain_ratio = best_cut / len(norm)
        if retain_ratio >= 0.9:
            continue  # tail is small; not worth trimming
        # Cut the original (un-normalized) text proportionally. We walk
        # the original until we've seen `best_cut` normalized chars, so
        # punctuation/whitespace in the original stays attached to the
        # surviving prefix.
        kept = 0
        cut_at_orig = len(c['text'])
        for oi, ch in enumerate(c['text']):
            if norm_text(ch):
                kept += 1
            if kept >= best_cut:
                cut_at_orig = oi + 1
                break
        c['text'] = c['text'][:cut_at_orig]
        # Shrink duration: Whisper's end timestamp was inflated by the
        # repetition spew, but its start is trustworthy. We use TWO bounds
        # and take the tighter one:
        #   1. Proportional: dur * retain_ratio (text-based)
        #   2. Speech-rate cap: retained_chars * 0.4s/char (Chinese ≈2.5
        #      chars/s; this catches the case where the legitimate prefix
        #      is itself crammed into a window where audio mostly contains
        #      a different paragraph than what Whisper transcribed).
        kept_norm_chars = len(norm_text(c['text']))
        cap_by_speech = kept_norm_chars * 0.4
        cap_by_ratio = dur * retain_ratio
        c['end'] = c['start'] + min(cap_by_ratio, max(cap_by_speech, 0.5))
    # Strip trailing hallucinated/repeated cues
    if len(cues) > 10:
        tail_start = max(0, len(cues) - 30)
        for i in range(tail_start, len(cues) - 2):
            t = norm_text(cues[i]['text'])
            if len(t) < 2:
                continue
            rep = sum(1 for j in range(i+1, len(cues)) if norm_text(cues[j]['text']) == t)
            if rep >= 3:
                cues = cues[:i]
                break
    return cues

def parse_time(s):
    """Parse VTT timestamp to seconds. Tolerates HH:MM:SS.mmm, MM:SS.mmm,
    bare seconds (SS.mmm), and HH:MM:SS:FF (trailing frame field ignored).
    Never raises — a single malformed line must not abort the whole align."""
    s = s.replace(',', '.').strip()
    parts = s.split(':')
    try:
        if len(parts) == 1:
            return float(parts[0])
        if len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
        # 3+ fields: HH:MM:SS(.mmm)[:FF] — use the first three, ignore frames
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    except (ValueError, IndexError):
        m = re.search(r'[\d.]+', s)
        return float(m.group(0)) if m else 0.0

def merge_cues(cues, target_len=40):
    """Merge consecutive short cues into chunks of ~target_len chars."""
    chunks = []
    indices = []
    current = ""
    cur_indices = []
    for i, c in enumerate(cues):
        current += c['text']
        cur_indices.append(i)
        if len(current) >= target_len:
            chunks.append(current)
            indices.append(list(cur_indices))
            current = ""
            cur_indices = []
    if current:
        chunks.append(current)
        indices.append(list(cur_indices))
    return chunks, indices

def char_similarity(a, b):
    """Character-level similarity via multiset (Counter) overlap of normalized
    chars — NOT an LCS; order is ignored, repeats can't inflate the score.
    Zero-robust to ASR homophones by construction (弗学 vs 佛学 → 0.2); use
    char_similarity_ex() anywhere ASR text meets article text."""
    a = norm_text(a)
    b = norm_text(b)
    if not a or not b:
        return 0.0
    m, n = len(a), len(b)
    if m > 200 or n > 200:
        a, b = a[:200], b[:200]
        m, n = len(a), len(b)
    # Use a sliding window approach for efficiency when lengths differ a lot
    shorter, longer = (a, b) if m <= n else (b, a)
    if len(longer) > len(shorter) * 3:
        # Slide shorter over longer, find best overlap. Use multiset (Counter)
        # intersection per window so repeated chars can't inflate the score —
        # e.g. "啊啊啊" vs a window containing a single "啊" scores 1/3, not 1.0.
        cs = Counter(shorter)
        best = 0.0
        step = max(1, len(shorter) // 2)
        for start in range(0, len(longer) - len(shorter) + 1, step):
            window = longer[start:start + len(shorter) + len(shorter) // 2]
            common = sum((cs & Counter(window)).values())
            best = max(best, common / max(len(shorter), 1))
        return best
    # Simple character overlap ratio
    ca, cb = Counter(a), Counter(b)
    common = sum((ca & cb).values())
    return 2 * common / (len(a) + len(b))


_PANEL_HEADERS = ('今日得到', '今日思考', '划重点', '参考材料', '知识卡片',
                  '本周留言精选', '留言精选', '用户留言', '思考题', '推荐阅读',
                  '本讲小结', '课后思考', '延伸阅读')

def _is_panel_header(text):
    """得到-style appendix panel headings (今日得到/划重点/…). When unmapped
    these are UI chrome the narrator never reads — they must not receive
    interpolated audio time (a 0.2-2s flash-highlight with an auto-scroll)."""
    nt = norm_text(text)
    if not nt or len(nt) > 12:
        return False
    for h in _PANEL_HEADERS:
        nh = norm_text(h)
        if nt == nh or nt.startswith(nh) or nt.endswith(nh):
            return True
    return False

def detect_dialogue_runs(segments, max_char=30):
    """Detect runs of consecutive short segments (dialogue lines).
    Returns list of (start, end) tuples (inclusive).
    A run must have at least 3 segments.
    """
    runs = []
    i = 0
    n = len(segments)
    while i < n:
        if len(segments[i]) <= max_char:
            j = i
            while j < n and len(segments[j]) <= max_char:
                j += 1
            if j - i >= 3:
                runs.append((i, j - 1))
            i = j
        else:
            i += 1
    return runs


def align(segments, cues, model):
    """Use embedding similarity to align VTT cues to article segments.
    
    Strategy:
    1. Pre-merge dialogue runs (consecutive short segments) into virtual segments
       so the main embedding alignment treats them as one block
    2. Forward pass: greedily assign chunks to virtual segments with monotonic constraint
    3. Post-expand: redistribute cues within dialogue runs using char-level matching
    4. Gap fill: redistribute cues when segments are skipped
    """
    if not segments or not cues:
        return [], []
    
    n = len(segments)
    
    # Detect dialogue runs for pre-merging
    dialogue_runs = detect_dialogue_runs(segments)
    
    # Build virtual segment list: merge dialogue runs into single virtual segments
    # vseg_map[vi] = list of original segment indices that make up virtual segment vi
    vseg_list = []   # virtual segment texts
    vseg_map = []    # vseg_map[vi] = [orig_seg_indices]
    
    in_run = {}  # orig_seg_idx -> (run_start, run_end)
    for rs, re_ in dialogue_runs:
        for si in range(rs, re_ + 1):
            in_run[si] = (rs, re_)
    
    si = 0
    while si < n:
        if si in in_run:
            rs, re_ = in_run[si]
            if si == rs:  # only process at run start
                merged_text = ' '.join(segments[j] for j in range(rs, re_ + 1))
                vseg_list.append(merged_text)
                vseg_map.append(list(range(rs, re_ + 1)))
            si = re_ + 1
        else:
            vseg_list.append(segments[si])
            vseg_map.append([si])
            si += 1
    
    vn = len(vseg_list)
    
    # Merge cues into chunks for better embedding quality.
    # target_len=20 keeps chunks small enough that short segments (H2 headings,
    # short paragraphs) can win their own chunk instead of being swallowed by a
    # 40-char chunk that straddles a paragraph break.
    chunks, chunk_indices = merge_cues(cues, target_len=20)
    
    # Encode all texts
    vseg_texts = [s[:300] for s in vseg_list]  # cap; merged segs can be longer
    chunk_texts = [c[:200] for c in chunks]
    
    vseg_embs = model.encode(vseg_texts, normalize_embeddings=True, batch_size=32)
    chunk_embs = model.encode(chunk_texts, normalize_embeddings=True, batch_size=32)
    
    # Similarity matrix (chunks x virtual_segments)
    sim_matrix = np.dot(chunk_embs, vseg_embs.T)
    
    # DTW: globally optimal monotonic alignment of chunks → vsegs.
    # dp[ci][vi] = best cumulative score using chunks 0..ci, chunk ci mapped to vseg vi.
    # Transitions allowed: vk → vi for vk <= vi.
    # Penalty: 0 if vk == vi (stay) or vk == vi-1 (advance one); SKIP_PENALTY*(vi-vk-1)
    # for skipping >= 1 vseg. This prevents local-greedy wedging where one over-eager
    # forward jump traps all subsequent chunks at a wrong segment.
    C = len(chunks)
    SKIP_PENALTY = 0.15
    START_PENALTY = 0.05  # penalize starting beyond vseg 0

    dp = np.full((C, vn), -np.inf, dtype=np.float64)
    parent = np.full((C, vn), -1, dtype=np.int32)

    for vi in range(vn):
        dp[0, vi] = float(sim_matrix[0, vi]) - START_PENALTY * vi
        parent[0, vi] = vi  # self-pointer; not used in backtrack past ci=0

    for ci in range(1, C):
        prev = dp[ci - 1]
        sim_row = sim_matrix[ci]
        # Running best of (prev[vk] + SKIP*vk) for vk in [0, vi-2], used for skip case.
        # Adjusted form so skip cost factors out cleanly.
        running_best = -np.inf
        running_best_vk = -1
        for vi in range(vn):
            # Admit vk = vi - 2 to running_best (skip case starts at vk <= vi-2)
            if vi - 2 >= 0:
                adj = prev[vi - 2] + SKIP_PENALTY * (vi - 2)
                if adj > running_best:
                    running_best = adj
                    running_best_vk = vi - 2
            # Three candidates: stay (vk=vi), advance (vk=vi-1), skip (vk<=vi-2)
            best_val = prev[vi]
            best_vk = vi
            if vi - 1 >= 0 and prev[vi - 1] > best_val:
                best_val = prev[vi - 1]
                best_vk = vi - 1
            if running_best_vk >= 0:
                skip_val = running_best - SKIP_PENALTY * (vi - 1)
                if skip_val > best_val:
                    best_val = skip_val
                    best_vk = running_best_vk
            dp[ci, vi] = float(sim_row[vi]) + best_val
            parent[ci, vi] = best_vk

    chunk_vassignments = [0] * C
    last_vi = int(np.argmax(dp[C - 1]))
    chunk_vassignments[C - 1] = last_vi
    for ci in range(C - 1, 0, -1):
        last_vi = int(parent[ci, last_vi])
        if last_vi < 0:
            last_vi = 0
        chunk_vassignments[ci - 1] = last_vi
    
    # --- Expand virtual assignments back to original segment indices ---
    # For non-dialogue vsegs: direct mapping
    # For dialogue vsegs: use char_similarity to assign individual cues to sub-segments
    
    # First, build per-cue assignment to original segments
    cue_to_seg = [0] * len(cues)
    
    for ci, vi in enumerate(chunk_vassignments):
        orig_segs = vseg_map[vi]
        
        if len(orig_segs) == 1:
            # Simple case: one-to-one
            for cue_idx in chunk_indices[ci]:
                cue_to_seg[cue_idx] = orig_segs[0]
        else:
            # This chunk maps to a dialogue run — will be handled below
            for cue_idx in chunk_indices[ci]:
                cue_to_seg[cue_idx] = orig_segs[0]  # placeholder
    
    # Pre-build vi → [chunk_index] reverse map (was nested O(C·N_cues) below)
    vi_to_chunks = {}
    for ci, vi in enumerate(chunk_vassignments):
        vi_to_chunks.setdefault(vi, []).append(ci)
    # Pre-build run_start → vseg index map
    run_to_vi = {orig_segs[0]: vi for vi, orig_segs in enumerate(vseg_map) if len(orig_segs) > 1}

    # For dialogue runs: collect all cues assigned to them and redistribute
    for rs, re_ in dialogue_runs:
        vi_for_run = run_to_vi.get(rs)
        if vi_for_run is None:
            continue

        run_cues = []
        for ci in vi_to_chunks.get(vi_for_run, ()):
            run_cues.extend(chunk_indices[ci])

        if not run_cues:
            continue
        
        run_cues.sort()
        run_segs = list(range(rs, re_ + 1))
        
        # Monotonic char-level assignment
        last_assigned = 0  # index into run_segs
        
        for cue_idx in run_cues:
            cue_text = cues[cue_idx]['text']

            best_ri = -1
            best_score = -1.0

            for ri in range(last_assigned, len(run_segs)):
                si = run_segs[ri]
                target = segments[si]
                # For very short dialogue lines (e.g. "是的"), char_similarity
                # falsely scores ~1.0 because their characters appear in almost
                # any Chinese cue text. Require strict substring match instead.
                nt = norm_text(target)
                if 0 < len(nt) <= 5:
                    cs = 1.0 if (nt in norm_text(cue_text) or _pinyin_substr(target, cue_text)) else 0.0
                else:
                    cs = char_similarity_ex(cue_text, target)
                if ri == last_assigned:
                    cs += 0.03  # locality
                if cs > best_score:
                    best_score = cs
                    best_ri = ri

            if best_score >= 0.25 and best_ri >= last_assigned:
                last_assigned = best_ri
                cue_to_seg[cue_idx] = run_segs[best_ri]
            else:
                cue_to_seg[cue_idx] = run_segs[last_assigned]
    
    # Convert per-cue assignments to chunk-level (for backfill compatibility)
    # Use majority vote per chunk
    chunk_assignments = []
    for ci in range(len(chunks)):
        cue_indices_in_chunk = chunk_indices[ci]
        seg_votes = [cue_to_seg[idx] for idx in cue_indices_in_chunk]
        most_common = Counter(seg_votes).most_common(1)[0][0]
        chunk_assignments.append(most_common)
    
    # Restore monotonicity
    for ci in range(1, len(chunk_assignments)):
        if chunk_assignments[ci] < chunk_assignments[ci - 1]:
            chunk_assignments[ci] = chunk_assignments[ci - 1]
    
    # --- Pass 3: Backfill pass: recover skipped segments ---
    # Find segments that got zero chunks assigned.
    # Only attempt backfill for segments with enough text (>20 chars);
    # very short segments (e.g. "《金刚经》属于玄妙的佛学。") are better handled
    # by the interpolation/borrow pass since they occupy little audio time.
    #
    # Two rounds: round 1 only steals from IMMEDIATE neighbors (the original,
    # conservative behavior). Round 2 walks outward up to ±5 segs to find the
    # nearest mapped donor — needed when MANY consecutive segs were skipped,
    # because in round 1 their immediate neighbors are also empty so the loop
    # short-circuits. Round 1 first lets the easy cases land, so round 2 has
    # round-1 successes as new in-range donors.
    #
    # sim_matrix is (C, vn) but seg indices are in [0, n) where n >= vn when
    # dialogue runs merged consecutive segs. Look up via seg→vi mapping.
    seg_to_vi = {}
    for _vi, _segs in enumerate(vseg_map):
        for _si in _segs:
            seg_to_vi[_si] = _vi
    def _sim_for_seg(ci, si):
        vi = seg_to_vi.get(si)
        if vi is None or vi >= sim_matrix.shape[1]:
            return 0.0
        return float(sim_matrix[ci, vi])

    def _do_backfill(round_n):
        assigned_segs = set(chunk_assignments)
        for si in range(n):
            if si in assigned_segs:
                continue
            if len(segments[si]) < 20:
                continue

            if round_n == 1:
                donors = set()
                if si > 0: donors.add(si - 1)
                if si < n - 1: donors.add(si + 1)
            else:
                # Walk outward up to ±5 to find nearest MAPPED segs on each side
                donors = set()
                for d in range(1, 6):
                    if si - d >= 0 and (si - d) in assigned_segs:
                        donors.add(si - d); break
                for d in range(1, 6):
                    if si + d < n and (si + d) in assigned_segs:
                        donors.add(si + d); break

            best_ci = -1
            best_sim = 0.0
            for ci in range(len(chunks)):
                if chunk_assignments[ci] not in donors:
                    continue
                s = _sim_for_seg(ci, si)
                if s > best_sim:
                    best_sim = s
                    best_ci = ci

            # ASR homophone errors drag the embedding sim of a genuinely
            # matching chunk from ~0.9 down to ~0.55-0.6 (measured on whisper
            # VTTs), leaving it hovering at the acceptance threshold. When the
            # embedding alone is borderline, let a strong pinyin/char match of
            # the chunk text vote the rescue through.
            accept = False
            if best_ci >= 0:
                if best_sim >= 0.55:
                    accept = True
                elif best_sim >= 0.40 and char_similarity_ex(chunks[best_ci], segments[si]) >= 0.5:
                    accept = True
            if accept:
                cur_a = chunk_assignments[best_ci]
                cur_sim = _sim_for_seg(best_ci, cur_a)
                cur_count = sum(1 for a in chunk_assignments if a == cur_a)
                if best_sim >= cur_sim - 0.15 or cur_count > 3:
                    chunk_assignments[best_ci] = si
                    assigned_segs.add(si)
    _do_backfill(1)
    _do_backfill(2)

    # Re-run round 2 to catch chains that needed multiple iterations (each
    # rescue gives the next attempt a new donor). Cap at 3 sweeps to bound work.
    for _ in range(2):
        before = sum(1 for ca in set(chunk_assignments))
        _do_backfill(2)
        if sum(1 for ca in set(chunk_assignments)) == before:
            break

    # Restore monotonicity after backfill (fix any inversions)
    for ci in range(1, len(chunk_assignments)):
        if chunk_assignments[ci] < chunk_assignments[ci - 1]:
            chunk_assignments[ci] = chunk_assignments[ci - 1]
    
    # Expand to per-cue segMap
    seg_map = [0] * len(cues)
    for ci, seg_idx in enumerate(chunk_assignments):
        for cue_idx in chunk_indices[ci]:
            seg_map[cue_idx] = seg_idx

    # --- Per-cue snap-to-heading pass ---
    # When a single cue's text closely matches a *short* segment (e.g. a heading
    # like "第二是自我成长的超越性") that the chunk-level assignment swallowed
    # into a neighbor, snap that one cue to the heading. Maintains monotonicity.
    SNAP_MIN_SIM = 0.55       # min similarity to consider snapping
    SNAP_GAIN = 0.15          # required improvement over current sim
    SNAP_LOOKAHEAD = 4        # how many segs forward to consider
    MAX_HEADING_LEN = 30      # only snap to short segs (treat as heading-like)
    SHORT_TARGET_LEN = 5      # below this, require strict substring match
                              # (char_similarity falsely scores ~1.0 for 2-3
                              # char targets like "是的"/"嗯" because their
                              # characters appear in almost any Chinese text)

    def _snap_sim(cue_text, target):
        nt = norm_text(target)
        nc = norm_text(cue_text)
        if not nt:
            return 0.0
        if len(nt) <= SHORT_TARGET_LEN:
            return 1.0 if (nt in nc or _pinyin_substr(target, cue_text)) else 0.0
        return char_similarity_ex(cue_text, target)

    def _boundary_sim(cue_text, target):
        # Same short-target substring rule as _snap_sim to avoid
        # char_similarity false positives on 2-3 char dialogue segments.
        nt = norm_text(target)
        if not nt:
            return 0.0
        if len(nt) <= SHORT_TARGET_LEN:
            return 1.0 if (nt in norm_text(cue_text) or _pinyin_substr(target, cue_text)) else 0.0
        return char_similarity_ex(cue_text, target)

    def _is_duplicate_seg(i):
        # True if segments[i]'s leading text appears as substring in an
        # EARLIER segment. Detects OCR-pasted summaries (划重点 列表 repeating
        # opening paragraphs) and accidental duplicates from rebuilt PDFs.
        # Earlier-only avoids flagging the original (seg 3 real content; seg
        # 46 that pastes seg 3 is the duplicate). Such segments have no audio
        # time and must not borrow/redistribute time from mapped neighbors.
        nt = norm_text(segments[i])
        if len(nt) < 10:
            return False
        head_len = max(15, len(nt) // 2)
        head = nt[:head_len]
        for j in range(i):
            on = norm_text(segments[j])
            if head in on:
                return True
        return False

    # Pre-compute which segs are currently empty (skipped by DTW/backfill).
    # Snap may ONLY target empty segs — otherwise a cue that spuriously matches
    # (via shared character like "初段") a heavily-used downstream seg snaps
    # forward, then the monotonicity force-up drags every subsequent cue with
    # it, erasing legitimate mappings to intermediate segs. Real-world failure:
    # cue 42 "也就是拿到初段" was snapping to seg 10 "所谓初段的闭环..." at
    # sim 0.57, dragging 20 cues with it and wiping segs 7/8/9.
    _occupied_segs = set(seg_map)

    last_assigned = 0
    for ci in range(len(cues)):
        cur_seg = seg_map[ci]
        if cur_seg < last_assigned:
            cur_seg = last_assigned
            seg_map[ci] = cur_seg
        cue_text = cues[ci]['text']
        cur_sim = _snap_sim(cue_text, segments[cur_seg]) if cur_seg < n else 0.0
        best_si = cur_seg
        best_sim = cur_sim
        for si in range(cur_seg + 1, min(n, cur_seg + 1 + SNAP_LOOKAHEAD)):
            if len(segments[si]) > MAX_HEADING_LEN:
                continue
            if si in _occupied_segs:
                continue
            sim = _snap_sim(cue_text, segments[si])
            if sim >= SNAP_MIN_SIM and sim >= cur_sim + SNAP_GAIN and sim > best_sim:
                best_si = si
                best_sim = sim
        if best_si != cur_seg:
            seg_map[ci] = best_si
            _occupied_segs.add(best_si)
        last_assigned = seg_map[ci]

    # --- Strip spurious cue support from panel headers ---
    # A stray ASR fragment (a cut-off "暴") or an embedding coincidence (chunk
    # "好，我们留下思考题" vs heading "今日思考") sometimes lands on an appendix
    # heading; the heading then flash-highlights with an auto-scroll, and —
    # because it counts as "mapped" — blocks the boundary/gap passes below from
    # placing those cues where they belong. Keep a header mapped only when its
    # cues actually SAY the heading; otherwise hand the cues back to the
    # previous mapped segment. Runs BEFORE boundary refinement so the freed
    # cues can be redistributed properly.
    _ms0 = set(seg_map)
    for s2 in sorted(_ms0):
        if not (0 <= s2 < n) or not _is_panel_header(segments[s2]):
            continue
        sup = [ci2 for ci2, x in enumerate(seg_map) if x == s2]
        joined_txt = ''.join(cues[c]['text'] for c in sup)
        nh = norm_text(segments[s2])
        if nh and (nh in norm_text(joined_txt) or _pinyin_substr(segments[s2], joined_txt)):
            continue
        prev_mapped = max((x for x in _ms0 if x < s2), default=None)
        if prev_mapped is None:
            continue
        for ci2 in sup:
            seg_map[ci2] = prev_mapped
        _ms0.discard(s2)

    # --- Per-cue boundary refinement pass ---
    # At each transition (seg_map[ci]=A, seg_map[ci+1]=B with A+1==B), examine
    # the cues in a window around ci and pick the split point that maximizes
    # total per-cue similarity. Fixes systematic delay/early-jump caused by
    # chunk-level boundaries: a chunk crossing a paragraph break gets assigned
    # whole to one side, putting some cues on the wrong segment and pushing
    # segTimeRanges[B].start to a cue that actually belongs to A (or vice
    # versa). Maintains monotonicity since we only swap labels within [A, B].
    BOUNDARY_WIN = 4  # cues on each side of transition

    ci_iter = 0
    while ci_iter < len(seg_map) - 1:
        if seg_map[ci_iter] == seg_map[ci_iter + 1]:
            ci_iter += 1
            continue
        A = seg_map[ci_iter]
        B = seg_map[ci_iter + 1]
        if A < 0 or B >= n:
            ci_iter += 1
            continue
        # Adjacent segments refine directly. A gap transition is treated as
        # pseudo-adjacent ONLY when nothing in between is mapped (the skipped
        # interiors are panels/unspoken content; genuinely spoken interiors
        # are claimed by the gap-rescue pass below). Without this, a cue like
        # "好，我们留下思考题" stays glued to the previous section and the
        # following segment's start drifts several seconds late.
        if A + 1 != B:
            _mapped_now = set(seg_map)
            if any(s in _mapped_now for s in range(A + 1, B)):
                ci_iter += 1
                continue
        lo = ci_iter
        while lo > 0 and seg_map[lo - 1] == A and (ci_iter - lo + 1) < BOUNDARY_WIN:
            lo -= 1
        hi = ci_iter + 1
        while hi < len(seg_map) - 1 and seg_map[hi + 1] == B and (hi - ci_iter) < BOUNDARY_WIN:
            hi += 1
        simA = [_boundary_sim(cues[j]['text'], segments[A]) for j in range(lo, hi + 1)]
        simB = [_boundary_sim(cues[j]['text'], segments[B]) for j in range(lo, hi + 1)]
        # Best split k: cues [lo..k) → A, [k..hi+1) → B
        prefixA = [0.0] * (hi - lo + 2)
        suffixB = [0.0] * (hi - lo + 2)
        for j in range(hi - lo + 1):
            prefixA[j + 1] = prefixA[j] + simA[j]
        for j in range(hi - lo, -1, -1):
            suffixB[j] = suffixB[j + 1] + simB[j]
        best_score = -1.0
        best_k = ci_iter + 1
        for k in range(lo, hi + 2):
            score = prefixA[k - lo] + suffixB[k - lo]
            if score > best_score:
                best_score = score
                best_k = k
        for j in range(lo, best_k):
            seg_map[j] = A
        for j in range(best_k, hi + 1):
            seg_map[j] = B
        ci_iter = hi + 1

    # --- Gap-transition rescue pass ---
    # At a transition A→B that JUMPS over unmapped segments, the prefix of the
    # B-run may actually speak one of the skipped segments. Real case: a short
    # transitional cue ("好，这一讲就到这儿") embedding-matched B early, and
    # monotonicity then dragged the following cues — which verbatim speak the
    # skipped summary segment — past it. Walk the B-run prefix and relabel
    # cues to interior segments (ascending, contiguous prefix only, so
    # monotonicity is preserved by construction) when the pinyin-aware match
    # is clearly better than what the cue scores against B.
    GAP_WIN = 6
    ci_iter = 0
    while ci_iter < len(seg_map) - 1:
        A = seg_map[ci_iter]
        B = seg_map[ci_iter + 1]
        if B <= A + 1:
            ci_iter += 1
            continue
        interiors = [s for s in range(A + 1, B) if len(norm_text(segments[s])) >= 8]
        if not interiors:
            ci_iter += 1
            continue
        hi = ci_iter + 1
        while hi < len(seg_map) - 1 and seg_map[hi + 1] == B and (hi - ci_iter) < GAP_WIN:
            hi += 1
        # Only bother when some window cue clearly speaks an interior segment.
        window = list(range(ci_iter + 1, hi + 1))
        has_interior_hit = any(
            max(char_similarity_ex(cues[j]['text'], segments[s]) for s in interiors) >= 0.45
            for j in window)
        if not has_interior_hit:
            ci_iter = hi + 1
            continue
        ptr = -1           # index into interiors of the last assignment
        orphan_budget = 2  # transition ad-libs we may park without breaking
        j = ci_iter + 1
        while j <= hi:
            ct = cues[j]['text']
            cur_sim = char_similarity_ex(ct, segments[B]) if B < n else 0.0
            best_k = -1
            best_sim = 0.0
            for k in range(max(ptr, 0), len(interiors)):
                sim = char_similarity_ex(ct, segments[interiors[k]])
                if sim > best_sim:
                    best_sim = sim
                    best_k = k
            if best_k >= 0 and best_sim >= 0.45 and best_sim > cur_sim + 0.10:
                seg_map[j] = interiors[best_k]
                ptr = best_k
                j += 1
            elif orphan_budget > 0 and best_sim < 0.35 and cur_sim < 0.35:
                # Pure transition ad-lib ("好，这一讲就到这儿") matching neither
                # side: park it on the previous label so it can't block the
                # prefix walk toward the genuinely-spoken interior text.
                seg_map[j] = A if ptr < 0 else interiors[ptr]
                orphan_budget -= 1
                j += 1
            else:
                break  # a genuine B cue ends the relabelable prefix
        ci_iter = hi + 1

    # --- Merge identical-twin segments ---
    # Upstream OCR rebuilds occasionally paste the same paragraph twice. The
    # twins have identical text, so the aligner splits one speech run between
    # them and the highlight hops mid-sentence from one copy to the other.
    # When two CONSECUTIVELY-mapped segments are verbatim duplicates, give the
    # later twin's cues back to the earlier one; the later twin goes unmapped
    # (and the non-spoken weighting below keeps it from soaking up time).
    _norm_segs = [norm_text(s) for s in segments]
    _mapped_sorted = sorted(set(seg_map))
    for _k in range(len(_mapped_sorted) - 1):
        i_, j_ = _mapped_sorted[_k], _mapped_sorted[_k + 1]
        if len(_norm_segs[i_]) >= 10 and _norm_segs[i_] == _norm_segs[j_]:
            for ci2 in range(len(seg_map)):
                if seg_map[ci2] == j_:
                    seg_map[ci2] = i_

    # --- Tail isolated-match gate ---
    # Trailing cues (usually the spoken "下一讲预告", absent from the article)
    # sometimes embedding-match a 划重点 bullet deep in the unmapped appendix.
    # That one spurious hit turns what should be a quiet null tail into an
    # interpolation chain, and the last seconds of playback hop-highlight
    # through the appendix with auto-scrolls to match. Gate: the LAST mapped
    # segment, when it sits in the final 20% of the article, separated from
    # the previous mapped segment by >=2 unmapped ones and holding <=4 cues,
    # must sound like its text — the island's cues JOINED (a preview only
    # brushes the bullet with a few chars, so joint sim stays low, while a
    # genuinely spoken bullet covers most of it) at a physically possible
    # speech rate — or its cues return to the previous mapped segment (the
    # highlight then rests there: the null-tail design behavior).
    while True:
        _ms = sorted(set(seg_map))
        if len(_ms) < 2:
            break
        X = _ms[-1]
        P = _ms[-2]
        if X < n * 0.8 or X - P < 3:
            break
        island = [ci2 for ci2, s2 in enumerate(seg_map) if s2 == X]
        if len(island) > 4:
            break
        joined = ''.join(cues[ci2]['text'] for ci2 in island)
        sim = char_similarity_ex(joined, segments[X])
        span = cues[island[-1]]['end'] - cues[island[0]]['start']
        chars = len(norm_text(segments[X]))
        rate_impossible = span > 0 and chars / max(span, 0.01) > 20
        if sim >= 0.35 and not rate_impossible:
            break
        for ci2 in island:
            seg_map[ci2] = P

    # Derive segTimeRanges
    seg_first = [None] * n
    seg_last = [None] * n
    for i, s in enumerate(seg_map):
        if 0 <= s < n:
            if seg_first[s] is None:
                seg_first[s] = i
            seg_last[s] = i

    # --- Trim trailing orphan cues before a skipped section ---
    # When the spoken audio ad-libs transitional content with no article text
    # (e.g. "好了，讲完了X，咱们再聊一聊Y…") right before a heading/section the
    # aligner skipped (left unmapped), those cues get absorbed into the PREVIOUS
    # segment — freezing its highlight for many seconds while the narrator has
    # already moved on, then flashing past the heading. If such trailing cues
    # match the current segment poorly AND lean toward the next mapped segment
    # (the section they introduce), drop them from this segment's audio extent.
    # The freed time then flows to the skipped heading via the gap-fill below,
    # so the highlight advances onto the heading as the narrator introduces it.
    # Bounded: only fires when an unmapped run immediately follows, only trims a
    # contiguous weak-match tail, and only when the freed span is >= 2s.
    def _next_mapped(i):
        for j in range(i + 1, n):
            if seg_first[j] is not None:
                return j
        return None
    for i in range(n):
        if seg_first[i] is None:
            continue
        if i + 1 >= n or seg_first[i + 1] is not None:
            continue  # require an unmapped (skipped) segment right after
        nj = _next_mapped(i)
        if nj is None:
            continue
        first_ci, last_ci = seg_first[i], seg_last[i]
        this_txt, next_txt = segments[i], segments[nj]
        new_last = last_ci
        saw_pure_orphan = False  # a cue matching NEITHER this seg nor the next
        while new_last > first_ci:
            ct = cues[new_last]['text']
            s_this = char_similarity_ex(ct, this_txt)
            s_next = char_similarity_ex(ct, next_txt)
            # Stop at the first cue that genuinely belongs to this segment.
            # A weak self-match that leans toward the upcoming section (or is a
            # pure orphan matching neither) is transitional → trim it.
            if s_this < 0.55 and s_next >= s_this:
                if s_this < 0.15 and s_next < 0.15:
                    saw_pure_orphan = True
                new_last -= 1
            else:
                break
        # Only trim when the tail is genuine ad-lib: it must contain a near-pure
        # orphan cue (a discourse break like "好了/那么…" present in the audio
        # but in no article segment). This keeps the fix surgical — normal
        # heading skips and messy Q&A interleaving (where the "orphan" tail is
        # really mis-attributed real speech) are left untouched. Span >= 2s.
        if (saw_pure_orphan and new_last < last_ci
                and (cues[last_ci]['end'] - cues[new_last]['end']) >= 2.0):
            seg_last[i] = new_last

    seg_time_ranges = []
    for i in range(n):
        if seg_first[i] is not None:
            seg_time_ranges.append({
                'start': cues[seg_first[i]]['start'],
                'end': cues[seg_last[i]]['end']
            })
        else:
            seg_time_ranges.append(None)
    
    # Fill gaps by interpolation — text-length proportional distribution
    audio_end = cues[-1]['end']

    # Precompute duplicate-seg flags: used to prevent borrow/redistribute from
    # giving non-spoken pasted content (OCR-duplicated 划重点 lists, accidental
    # paragraph repeats) audio time stolen from real mapped neighbors.
    dup_seg = [_is_duplicate_seg(i) for i in range(n)]
    
    # Identify contiguous runs of None entries and fill them proportionally
    i = 0
    while i < n:
        if seg_time_ranges[i] is not None:
            i += 1
            continue
        # Found start of a None run
        run_start_idx = i
        while i < n and seg_time_ranges[i] is None:
            i += 1
        run_end_idx = i - 1  # inclusive
        
        # Find time boundaries from neighbors
        prev_end = None
        next_start = None
        prev_idx = None
        next_idx = None
        for j in range(run_start_idx - 1, -1, -1):
            if seg_time_ranges[j]:
                prev_idx = j
                prev_end = seg_time_ranges[j]['end']
                break
        for j in range(run_end_idx + 1, n):
            if seg_time_ranges[j]:
                next_idx = j
                next_start = seg_time_ranges[j]['start']
                break
        
        # Spoken-likelihood weights: panel headings (今日得到/划重点/…) and
        # duplicate-pasted segments are never narrated — zero weight, so they
        # get a zero-width range at the cursor instead of a flash of stolen
        # time. A panel heading also zeroes everything AFTER it in the run
        # (its bullets/content belong to the same non-spoken panel block).
        # Everything else keeps its text length as weight.
        run_segments_idx = list(range(run_start_idx, run_end_idx + 1))
        weights = []
        _in_panel_block = False
        for si in run_segments_idx:
            if _is_panel_header(segments[si]):
                _in_panel_block = True
            if _in_panel_block or dup_seg[si]:
                weights.append(0)
            else:
                weights.append(max(len(segments[si]), 1))
        total_w = sum(weights)

        # Fully non-spoken interior run (all panels/dups): give it NO time at
        # all — extend the previous mapped segment across the gap (any audio
        # there is untexted ad-lib; the highlight should rest where it was)
        # and pin the run's segments as zero-width at the next segment's
        # start. The frontend's "last start <= t" pick then never lands on
        # them because the following mapped segment shares the same start.
        if prev_end is not None and next_start is not None and total_w == 0:
            if prev_idx is not None:
                seg_time_ranges[prev_idx]['end'] = next_start
            for si in run_segments_idx:
                seg_time_ranges[si] = {'start': next_start, 'end': next_start}
            continue

        # Determine available time for this gap
        if prev_end is not None and next_start is not None:
            gap_time = next_start - prev_end
            # If the gap is very small (<2s per segment), borrow time from neighbors
            run_len = sum(1 for w in weights if w > 0)
            needed_time = run_len * 1.5  # ~1.5s per spoken-like segment minimum
            # Don't borrow time for duplicate segs (OCR-pasted content with no
            # real audio) — keep the mapped neighbor's range intact.
            any_dup_in_run = any(dup_seg[j] for j in range(run_start_idx, run_end_idx + 1))
            if gap_time < needed_time and not any_dup_in_run:
                borrow_total = needed_time - gap_time
                # Borrow from prev (up to 40% of its duration)
                if prev_idx is not None:
                    prev_dur = seg_time_ranges[prev_idx]['end'] - seg_time_ranges[prev_idx]['start']
                    borrow_prev = min(borrow_total * 0.5, prev_dur * 0.4)
                    seg_time_ranges[prev_idx]['end'] -= borrow_prev
                    prev_end = seg_time_ranges[prev_idx]['end']
                    borrow_total -= borrow_prev
                # Borrow from next (up to 40% of its duration)
                if next_idx is not None and borrow_total > 0:
                    next_dur = seg_time_ranges[next_idx]['end'] - seg_time_ranges[next_idx]['start']
                    borrow_next = min(borrow_total, next_dur * 0.4)
                    seg_time_ranges[next_idx]['start'] += borrow_next
                    next_start = seg_time_ranges[next_idx]['start']
                gap_time = next_start - prev_end
            
            start_t = prev_end
        elif prev_end is not None:
            # Trailing unmapped run (ending headings / 参考材料 / 知识卡片 /
            # 划重点 / source links the aligner couldn't anchor).
            run_len = run_end_idx - run_start_idx + 1
            remaining = max(0, audio_end - prev_end)
            # If essentially no spoken audio remains after the last mapped
            # segment, this trailing run is non-narrated appendix: there is no
            # audio to follow. Leave its ranges as None so the follow-along
            # highlight rests on the last spoken segment instead of leaping to
            # the bottom of the article when playback reaches the end (the
            # "快速跳段" bug — all these segments would otherwise collapse to a
            # single zero-width point at audio_end). A spoken-but-unaligned
            # outro instead leaves real audio time (cues extend past prev_end)
            # => remaining is large => fall through and spread it below.
            if remaining < run_len * 0.8 or total_w == 0:
                continue  # entries stay None; skip the distribution block
            min_dur = 0.5 * run_len
            gap_time = max(remaining, min_dur)
            start_t = prev_end
        elif next_start is not None:
            gap_time = 0.5 * (run_end_idx - run_start_idx + 1)
            start_t = max(0, next_start - gap_time)
        else:
            start_t = 0
            gap_time = audio_end
        
        # Distribute proportionally by spoken-likelihood weight (panel headers
        # and duplicate segs weigh 0 → zero-width at the cursor, no flash).
        cursor = start_t
        denom = total_w if total_w > 0 else 1
        for idx_in_run, si in enumerate(run_segments_idx):
            seg_dur = gap_time * (weights[idx_in_run] / denom)
            seg_time_ranges[si] = {
                'start': cursor,
                'end': cursor + seg_dur
            }
            cursor += seg_dur
    
    # --- Redistribution pass: fix disproportionate time allocation ---
    # When a mapped segment has way more time than its text length warrants,
    # and adjacent unmapped segments are starved, redistribute proportionally.
    for i in range(n):
        if seg_first[i] is None:  # skip unmapped
            continue
        my_dur = seg_time_ranges[i]['end'] - seg_time_ranges[i]['start']
        my_len = max(len(segments[i]), 1)
        
        # Check for adjacent unmapped run after this segment
        if i + 1 < n and seg_first[i + 1] is None:
            # Find the run of unmapped segments after me
            run_end = i + 1
            while run_end < n and seg_first[run_end] is None:
                run_end += 1
            run_end -= 1  # inclusive

            # Skip trailing unmapped runs (划重点 / source-PDF links not in
            # audio) — stealing time from the last mapped seg causes the
            # highlight to fly past actual spoken content (e.g., 下一讲预告).
            if run_end >= n - 1:
                continue
            # Skip internal runs containing any duplicate seg (OCR paste).
            if any(dup_seg[j] for j in range(i + 1, run_end + 1)):
                continue

            _w = lambda j: 0 if (dup_seg[j] or _is_panel_header(segments[j])) else max(len(segments[j]), 1)
            unmapped_len = sum(_w(j) for j in range(i + 1, run_end + 1))
            if unmapped_len == 0:
                continue  # all panels/dups — nothing spoken to redistribute to
            unmapped_dur = sum(seg_time_ranges[j]['end'] - seg_time_ranges[j]['start']
                              for j in range(i + 1, run_end + 1))
            
            # If my time per char is >3x the unmapped time per char, redistribute
            my_rate = my_dur / my_len if my_len > 0 else 0
            unmapped_rate = unmapped_dur / unmapped_len if unmapped_len > 0 else 0
            
            if my_rate > 0 and unmapped_rate > 0 and my_rate > unmapped_rate * 3:
                # Redistribute: give time proportional to text length
                total_dur = my_dur + unmapped_dur
                total_len = my_len + unmapped_len
                
                # My new duration (proportional to text, but keep at least 50%)
                fair_dur = total_dur * (my_len / total_len)
                new_my_dur = max(fair_dur, my_dur * 0.4)  # keep at least 40%
                
                if new_my_dur < my_dur - 1.0:  # only if saving >1s
                    freed = my_dur - new_my_dur
                    seg_time_ranges[i]['end'] = seg_time_ranges[i]['start'] + new_my_dur

                    # Re-distribute freed time to unmapped segments by
                    # spoken-likelihood weight (panels/dups stay zero-width)
                    cursor = seg_time_ranges[i]['end']
                    total_freed = freed + unmapped_dur

                    for j in range(i + 1, run_end + 1):
                        seg_dur = total_freed * (_w(j) / unmapped_len)
                        seg_time_ranges[j] = {
                            'start': cursor,
                            'end': cursor + seg_dur
                        }
                        cursor += seg_dur
    
    # Make continuous (skip trailing non-narrated segments left as None)
    for i in range(1, n):
        if seg_time_ranges[i] is None or seg_time_ranges[i-1] is None:
            continue
        if seg_time_ranges[i]['start'] > seg_time_ranges[i-1]['end']:
            mid = (seg_time_ranges[i-1]['end'] + seg_time_ranges[i]['start']) / 2
            seg_time_ranges[i-1]['end'] = mid
            seg_time_ranges[i]['start'] = mid
        elif seg_time_ranges[i]['start'] < seg_time_ranges[i-1]['end']:
            seg_time_ranges[i]['start'] = seg_time_ranges[i-1]['end']

    if seg_time_ranges[0] is not None:
        seg_time_ranges[0]['start'] = 0
    # Extend the last narrated (non-None) segment to the end of speech so its
    # highlight persists through any trailing silence; None tail stays None.
    for _i in range(n - 1, -1, -1):
        if seg_time_ranges[_i] is not None:
            seg_time_ranges[_i]['end'] = audio_end
            break

    # Ensure no negative-duration ranges (can happen for trailing non-spoken segments)
    for i in range(n):
        if seg_time_ranges[i] is None:
            continue
        if seg_time_ranges[i]['end'] < seg_time_ranges[i]['start']:
            seg_time_ranges[i]['end'] = seg_time_ranges[i]['start']
        # Clamp to audio duration
        seg_time_ranges[i]['start'] = min(seg_time_ranges[i]['start'], audio_end)
        seg_time_ranges[i]['end'] = min(seg_time_ranges[i]['end'], audio_end)

    return seg_map, seg_time_ranges

def _file_sha1(path):
    h = hashlib.sha1()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 16), b''):
            h.update(chunk)
    return h.hexdigest()


# ── Model singleton (daemon mode loads it exactly once) ──
_MODEL = None

def _enable_hf_offline_if_cached():
    """Skip HuggingFace Hub's online revision checks (~5.5s per run through
    the local DNS/proxy) whenever the model snapshot is already on disk.
    A fresh install (no snapshot yet) keeps full online behavior so the
    first-ever run can still download the model."""
    try:
        base = os.environ.get('HF_HOME') or os.path.join(os.path.expanduser('~'), '.cache', 'huggingface')
        snap = os.path.join(base, 'hub', 'models--BAAI--bge-small-zh-v1.5', 'snapshots')
        if os.path.isdir(snap) and any(os.scandir(snap)):
            os.environ.setdefault('HF_HUB_OFFLINE', '1')
            os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')
    except Exception:
        pass

def get_model():
    global _MODEL
    if _MODEL is None:
        _enable_hf_offline_if_cached()
        from sentence_transformers import SentenceTransformer
        _MODEL = SentenceTransformer('BAAI/bge-small-zh-v1.5')
    return _MODEL


def run_job(article_path, vtt_path, output_path=None, segments=None):
    """One complete alignment job. Returns the result dict; when output_path
    is given the cache file is written ATOMICALLY (tmp + rename) so a
    concurrent reader can never observe a truncated JSON."""
    t0 = time.time()
    version = _load_align_version()  # fresh each job — a daemon may outlive a bump

    with open(article_path, 'r', encoding='utf-8') as f:
        md_text = f.read()
    with open(vtt_path, 'r', encoding='utf-8') as f:
        vtt_text = f.read()
    vtt_text = apply_hotwords(vtt_text, vtt_path)

    # Content hashes let server.js keep a cache whose mtime went stale but
    # whose inputs didn't actually change (iCloud touches, bulk re-syncs).
    md_hash = _file_sha1(article_path)
    vtt_hash = _file_sha1(vtt_path)

    if segments is None:
        segments = parse_segments(md_text)
    cues = parse_vtt(vtt_text)

    if not segments or not cues:
        # A legitimately empty article / empty VTT is NOT a failure. Still write
        # the cache file so server.js (which checks `code===0 && fs.existsSync`)
        # returns 200 with an empty map instead of a 500, and stamp the version
        # so it isn't regenerated forever.
        result = {
            'segMap': [], 'segTimeRanges': [],
            'stats': {
                'version': version,
                'segments': len(segments),
                'cues': len(cues),
                'segsHit': 0,
                'mdHash': md_hash,
                'vttHash': vtt_hash,
                'error': 'no segments or cues',
            },
        }
        _write_result(result, output_path)
        return result

    t1 = time.time()
    already_loaded = _MODEL is not None
    model = get_model()
    t2 = time.time()

    seg_map, seg_time_ranges = align(segments, cues, model)
    t3 = time.time()

    # Stats. Bump 'version' (align-version.json) whenever align.py logic
    # changes in a way that invalidates existing caches; server-side self-heal
    # compares and regenerates on mismatch.
    stats = {
        'version': version,
        'segments': len(segments),
        'cues': len(cues),
        'segsHit': len(set(seg_map)),
        'modelLoadTime': 0.0 if already_loaded else round(t2 - t1, 1),
        'alignTime': round(t3 - t2, 2),
        'totalTime': round(t3 - t0, 1),
        'mdHash': md_hash,
        'vttHash': vtt_hash,
    }

    result = {'segMap': seg_map, 'segTimeRanges': seg_time_ranges, 'stats': stats}
    _write_result(result, output_path)
    return result


def _write_result(result, output_path):
    if not output_path:
        return
    tmp = f"{output_path}.tmp{os.getpid()}"
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(result, f)
    os.replace(tmp, output_path)


def daemon_loop():
    """JSON-lines alignment server on stdin/stdout. Protocol:
      → {"id": <any>, "article": path, "vtt": path, "out": path, "segments": [..]|null}
      ← {"id": <any>, "ok": true, "stats": {...}}   (result JSON is in `out`)
      ← {"id": <any>, "ok": false, "error": "..."}
    The embedding model is loaded once at startup ({"ready":true} is emitted
    when serving can begin); server.js keeps this process warm so per-article
    alignment costs ~0.7s instead of ~10s of import+model-load per spawn."""
    t0 = time.time()
    get_model()
    sys.stdout.write(json.dumps({'ready': True, 'modelLoadTime': round(time.time() - t0, 2)}) + '\n')
    sys.stdout.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get('id')
            segs = req.get('segments')
            if not (isinstance(segs, list) and segs and all(isinstance(x, str) for x in segs)):
                segs = None
            result = run_job(req['article'], req['vtt'], req.get('out'), segs)
            resp = {'id': rid, 'ok': True, 'stats': result.get('stats')}
        except Exception as e:
            resp = {'id': rid, 'ok': False, 'error': str(e)[:500]}
        sys.stdout.write(json.dumps(resp) + '\n')
        sys.stdout.flush()


def main():
    # Optional --segments <path>: a JSON array of the EXACT segment texts the
    # frontend's collectArticleSegments() produced. When supplied we align
    # against those verbatim instead of re-deriving them with parse_segments().
    # This guarantees our segment COUNT matches the browser DOM, so the frontend
    # never rejects the alignment over a count mismatch and falls back to LCS —
    # eliminating the fragile parse_segments↔marked.parse↔innerText coupling.
    # parse_segments() remains the fallback (CLI use, or if the file is missing).
    argv = sys.argv[1:]
    if '--daemon' in argv:
        daemon_loop()
        return
    segments_path = None
    if '--segments' in argv:
        si = argv.index('--segments')
        segments_path = argv[si + 1] if si + 1 < len(argv) else None
        del argv[si:si + 2]

    if len(argv) < 2:
        print("Usage: python3 align.py [--segments segs.json] <article.md> <audio.vtt> [output.json] | --daemon", file=sys.stderr)
        sys.exit(1)

    article_path = argv[0]
    vtt_path = argv[1]
    output_path = argv[2] if len(argv) > 2 else None

    segments = None
    if segments_path:
        try:
            with open(segments_path, 'r', encoding='utf-8') as f:
                loaded = json.load(f)
            # Use verbatim (preserve count exactly — frontend already drops empties).
            if isinstance(loaded, list):
                segments = [str(x) for x in loaded]
        except Exception as e:
            print(f"[align] segments file unreadable, falling back to parse_segments: {e}", file=sys.stderr)

    result = run_job(article_path, vtt_path, output_path, segments)
    if output_path:
        print(json.dumps(result['stats']), file=sys.stderr)
    else:
        json.dump(result, sys.stdout)

if __name__ == '__main__':
    main()
