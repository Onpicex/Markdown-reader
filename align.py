#!/usr/bin/env python3
"""
Semantic alignment: match VTT cues to article paragraphs using embedding similarity.
Usage: python3 align.py <article_path> <vtt_path> [output_json_path]
Outputs JSON: { segMap: number[], segTimeRanges: {start,end}[], stats: {...} }
"""
import sys, json, re, time, os
import numpy as np

def norm_text(t):
    """Strip whitespace and punctuation for comparison."""
    t = re.sub(r'[\s\u3000\u00A0]', '', t)
    t = re.sub(r'[^\u4e00-\u9fff\u3400-\u4dbfa-zA-Z0-9]', '', t)
    return t.lower()

def parse_segments(md_text):
    """Extract paragraphs matching the browser DOM structure.
    
    Must match the frontend's querySelectorAll('p, h1-h6, li, ...') behaviour:
    - Consecutive non-blank lines (no blank line between) merge into one <p>
    - Blank lines separate <p> blocks
    - Headings (# ...) are individual elements
    - Ordered/unordered list items (1. ... or - ...) are individual <li> elements
    - ![[...]] audio/image embeds are skipped
    - Frontmatter (---) is skipped
    """
    # Strip frontmatter
    md_body = re.sub(r'^---\n.*?\n---\n', '', md_text, flags=re.DOTALL)
    # Remove ![[...]] lines
    md_body = re.sub(r'^!\[\[.*?\]\]$', '', md_body, flags=re.MULTILINE)
    
    # Split into blocks by blank lines
    blocks = re.split(r'\n\n+', md_body.strip())
    
    segments = []
    for block in blocks:
        block = block.strip()
        if not block:
            continue
        
        # Heading block: each heading line is a separate element
        if re.match(r'^#{1,6}\s+', block):
            text = re.sub(r'^#{1,6}\s+', '', block).strip()
            if len(text) >= 1:
                segments.append(text)
            continue
        
        # Ordered list block: lines starting with digits + dot
        ol_items = re.findall(r'^\d+\.\s+(.*)', block, re.MULTILINE)
        if ol_items and len(ol_items) > 0:
            # Check if this is really a list (most lines match)
            total_lines = [l.strip() for l in block.split('\n') if l.strip()]
            if len(ol_items) >= len(total_lines) * 0.5:
                for item in ol_items:
                    item = item.strip()
                    if len(item) >= 1:
                        segments.append(item)
                continue
        
        # Unordered list block
        ul_items = re.findall(r'^[-*]\s+(.*)', block, re.MULTILINE)
        if ul_items and len(ul_items) > 0:
            total_lines = [l.strip() for l in block.split('\n') if l.strip()]
            if len(ul_items) >= len(total_lines) * 0.5:
                for item in ul_items:
                    item = item.strip()
                    if len(item) >= 1:
                        segments.append(item)
                continue
        
        # Regular paragraph: all lines merge into one segment (like <p> with <br>)
        text = ' '.join(l.strip() for l in block.split('\n') if l.strip())
        if len(text) >= 1:
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
    """Parse VTT timestamp to seconds."""
    s = s.replace(',', '.')
    parts = s.split(':')
    if len(parts) == 2:
        return int(parts[0]) * 60 + float(parts[1])
    return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])

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
    """Character-level similarity using longest common subsequence ratio."""
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
        # Slide shorter over longer, find best overlap
        best = 0
        for start in range(0, len(longer) - len(shorter) + 1, max(1, len(shorter) // 2)):
            window = longer[start:start + len(shorter) + len(shorter) // 2]
            common = sum(1 for c in shorter if c in window)
            best = max(best, common / max(len(shorter), 1))
        return best
    # Simple character overlap ratio
    from collections import Counter
    ca, cb = Counter(a), Counter(b)
    common = sum((ca & cb).values())
    return 2 * common / (len(a) + len(b))


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
    
    # Merge cues into chunks for better embedding quality
    chunks, chunk_indices = merge_cues(cues, target_len=40)
    
    # Encode all texts
    vseg_texts = [s[:300] for s in vseg_list]  # cap; merged segs can be longer
    chunk_texts = [c[:200] for c in chunks]
    
    vseg_embs = model.encode(vseg_texts, normalize_embeddings=True, batch_size=32)
    chunk_embs = model.encode(chunk_texts, normalize_embeddings=True, batch_size=32)
    
    # Similarity matrix (chunks x virtual_segments)
    sim_matrix = np.dot(chunk_embs, vseg_embs.T)
    
    # Greedy monotonic assignment with locality bias
    last_vseg = 0
    chunk_vassignments = []  # index into vseg_list
    
    for ci in range(len(chunks)):
        search_start = max(0, last_vseg)
        search_end = min(vn, last_vseg + 8)
        
        best_idx = -1
        best_score = -1
        
        for vi in range(search_start, search_end):
            score = float(sim_matrix[ci, vi])
            jump = vi - last_vseg
            if jump == 0:
                score += 0.05
            elif jump == 1:
                score += 0.02
            elif jump > 3:
                score *= 0.92
            if score > best_score:
                best_score = score
                best_idx = vi
        
        raw_score = float(sim_matrix[ci, best_idx]) if best_idx >= 0 else 0
        
        if raw_score >= 0.25 and best_idx >= last_vseg:
            last_vseg = best_idx
            chunk_vassignments.append(best_idx)
        else:
            chunk_vassignments.append(last_vseg)
    
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
    
    # For dialogue runs: collect all cues assigned to them and redistribute
    for rs, re_ in dialogue_runs:
        # Find which virtual segment contains this run
        vi_for_run = None
        for vi, orig_segs in enumerate(vseg_map):
            if len(orig_segs) > 1 and orig_segs[0] == rs:
                vi_for_run = vi
                break
        if vi_for_run is None:
            continue
        
        # Collect all cues assigned to this virtual segment
        run_cues = []
        for cue_idx in range(len(cues)):
            # Check if this cue's chunk was assigned to this vseg
            for ci, vi in enumerate(chunk_vassignments):
                if vi == vi_for_run:
                    if cue_idx in chunk_indices[ci]:
                        run_cues.append(cue_idx)
        
        if not run_cues:
            continue
        
        run_cues.sort()
        run_segs = list(range(rs, re_ + 1))
        
        # Monotonic char-level assignment
        last_assigned = 0  # index into run_segs
        
        for cue_idx in run_cues:
            cue_text = cues[cue_idx]['text']
            
            best_ri = -1
            best_score = -1
            
            for ri in range(last_assigned, len(run_segs)):
                si = run_segs[ri]
                cs = char_similarity(cue_text, segments[si])
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
        from collections import Counter
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
    assigned_segs = set(chunk_assignments)
    for si in range(n):
        if si in assigned_segs:
            continue
        # Skip very short text segments — they flash by in audio anyway
        if len(segments[si]) < 20:
            continue
        # Skip segments in the last 10% (usually non-spoken, e.g. "划重点")
        if si >= n * 0.9:
            continue
        
        prev_si = si - 1 if si > 0 else None
        next_si = si + 1 if si < n - 1 else None
        
        best_ci = -1
        best_sim = 0.0
        
        for ci in range(len(chunks)):
            a = chunk_assignments[ci]
            # Only consider chunks assigned to immediate neighbors
            if a != prev_si and a != next_si:
                continue
            s = float(sim_matrix[ci, si])
            if s > best_sim:
                best_sim = s
                best_ci = ci
        
        if best_ci >= 0 and best_sim >= 0.55:
            cur_a = chunk_assignments[best_ci]
            cur_sim = float(sim_matrix[best_ci, cur_a])
            cur_count = sum(1 for a in chunk_assignments if a == cur_a)
            # Only steal if the match is close enough or donor has plenty of chunks
            if best_sim >= cur_sim - 0.15 or cur_count > 3:
                chunk_assignments[best_ci] = si
                # Also grab adjacent chunks that match well
                for delta in [-1, 1]:
                    adj_ci = best_ci + delta
                    if 0 <= adj_ci < len(chunks):
                        adj_sim = float(sim_matrix[adj_ci, si])
                        adj_cur = chunk_assignments[adj_ci]
                        adj_cur_sim = float(sim_matrix[adj_ci, adj_cur])
                        adj_cur_count = sum(1 for a in chunk_assignments if a == adj_cur)
                        if adj_sim >= 0.5 and (adj_sim >= adj_cur_sim - 0.1 or adj_cur_count > 4):
                            chunk_assignments[adj_ci] = si
    
    # Restore monotonicity after backfill (fix any inversions)
    for ci in range(1, len(chunk_assignments)):
        if chunk_assignments[ci] < chunk_assignments[ci - 1]:
            chunk_assignments[ci] = chunk_assignments[ci - 1]
    
    # Expand to per-cue segMap
    seg_map = [0] * len(cues)
    for ci, seg_idx in enumerate(chunk_assignments):
        for cue_idx in chunk_indices[ci]:
            seg_map[cue_idx] = seg_idx
    
    # Derive segTimeRanges
    seg_first = [None] * n
    seg_last = [None] * n
    for i, s in enumerate(seg_map):
        if 0 <= s < n:
            if seg_first[s] is None:
                seg_first[s] = i
            seg_last[s] = i
    
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
        
        # Determine available time for this gap
        if prev_end is not None and next_start is not None:
            gap_time = next_start - prev_end
            # If the gap is very small (<2s per segment), borrow time from neighbors
            run_len = run_end_idx - run_start_idx + 1
            needed_time = run_len * 1.5  # ~1.5s per segment minimum
            if gap_time < needed_time:
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
            gap_time = 0.5 * (run_end_idx - run_start_idx + 1)
            start_t = prev_end
        elif next_start is not None:
            gap_time = 0.5 * (run_end_idx - run_start_idx + 1)
            start_t = max(0, next_start - gap_time)
        else:
            start_t = 0
            gap_time = audio_end
        
        # Distribute proportionally by text length
        run_segments_idx = list(range(run_start_idx, run_end_idx + 1))
        text_lengths = [max(len(segments[si]), 1) for si in run_segments_idx]
        total_len = sum(text_lengths)
        
        cursor = start_t
        for idx_in_run, si in enumerate(run_segments_idx):
            proportion = text_lengths[idx_in_run] / total_len
            seg_dur = gap_time * proportion
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
            
            unmapped_len = sum(max(len(segments[j]), 1) for j in range(i + 1, run_end + 1))
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
                    
                    # Re-distribute freed time to unmapped segments proportionally
                    cursor = seg_time_ranges[i]['end']
                    remaining_unmapped_len = sum(max(len(segments[j]), 1) 
                                                  for j in range(i + 1, run_end + 1))
                    total_freed = freed + unmapped_dur
                    
                    for j in range(i + 1, run_end + 1):
                        seg_len = max(len(segments[j]), 1)
                        proportion = seg_len / remaining_unmapped_len
                        seg_dur = total_freed * proportion
                        seg_time_ranges[j] = {
                            'start': cursor,
                            'end': cursor + seg_dur
                        }
                        cursor += seg_dur
    
    # Make continuous
    for i in range(1, n):
        if seg_time_ranges[i]['start'] > seg_time_ranges[i-1]['end']:
            mid = (seg_time_ranges[i-1]['end'] + seg_time_ranges[i]['start']) / 2
            seg_time_ranges[i-1]['end'] = mid
            seg_time_ranges[i]['start'] = mid
        elif seg_time_ranges[i]['start'] < seg_time_ranges[i-1]['end']:
            seg_time_ranges[i]['start'] = seg_time_ranges[i-1]['end']
    
    seg_time_ranges[0]['start'] = 0
    seg_time_ranges[-1]['end'] = audio_end
    
    # Ensure no negative-duration ranges (can happen for trailing non-spoken segments)
    for i in range(n):
        if seg_time_ranges[i]['end'] < seg_time_ranges[i]['start']:
            seg_time_ranges[i]['end'] = seg_time_ranges[i]['start']
        # Clamp to audio duration
        seg_time_ranges[i]['start'] = min(seg_time_ranges[i]['start'], audio_end)
        seg_time_ranges[i]['end'] = min(seg_time_ranges[i]['end'], audio_end)
    
    return seg_map, seg_time_ranges

def main():
    if len(sys.argv) < 3:
        print("Usage: python3 align.py <article.md> <audio.vtt> [output.json]", file=sys.stderr)
        sys.exit(1)
    
    article_path = sys.argv[1]
    vtt_path = sys.argv[2]
    output_path = sys.argv[3] if len(sys.argv) > 3 else None
    
    t0 = time.time()
    
    # Read files
    with open(article_path, 'r') as f:
        md_text = f.read()
    with open(vtt_path, 'r') as f:
        vtt_text = f.read()
    
    segments = parse_segments(md_text)
    cues = parse_vtt(vtt_text)
    
    if not segments or not cues:
        result = {'segMap': [], 'segTimeRanges': [], 'stats': {'error': 'no segments or cues'}}
        json.dump(result, sys.stdout)
        return
    
    # Load model
    t1 = time.time()
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer('BAAI/bge-small-zh-v1.5')
    t2 = time.time()
    
    # Align
    seg_map, seg_time_ranges = align(segments, cues, model)
    t3 = time.time()
    
    # Stats
    segs_hit = len(set(seg_map))
    stats = {
        'segments': len(segments),
        'cues': len(cues),
        'segsHit': segs_hit,
        'modelLoadTime': round(t2 - t1, 1),
        'alignTime': round(t3 - t2, 2),
        'totalTime': round(t3 - t0, 1)
    }
    
    result = {
        'segMap': seg_map,
        'segTimeRanges': seg_time_ranges,
        'stats': stats
    }
    
    if output_path:
        with open(output_path, 'w') as f:
            json.dump(result, f)
        print(json.dumps(stats), file=sys.stderr)
    else:
        json.dump(result, sys.stdout)

if __name__ == '__main__':
    main()
