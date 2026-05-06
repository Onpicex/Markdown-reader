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
    """Extract paragraphs from markdown article."""
    in_fm = False
    segments = []
    for line in md_text.split('\n'):
        line = line.strip()
        if line == '---':
            in_fm = not in_fm
            continue
        if in_fm or not line or line.startswith('![['):
            continue
        if line.startswith('#'):
            line = re.sub(r'^#+\s*', '', line)
        if len(line) < 2:
            continue
        segments.append(line)
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

def align(segments, cues, model):
    """Use embedding similarity to align VTT cues to article segments."""
    if not segments or not cues:
        return [], []
    
    n = len(segments)
    
    # Merge cues into chunks for better embedding quality
    chunks, chunk_indices = merge_cues(cues, target_len=40)
    
    # Encode all texts
    seg_texts = [s[:200] for s in segments]  # cap at 200 chars
    chunk_texts = [c[:200] for c in chunks]
    
    seg_embs = model.encode(seg_texts, normalize_embeddings=True, batch_size=32)
    chunk_embs = model.encode(chunk_texts, normalize_embeddings=True, batch_size=32)
    
    # Similarity matrix
    sim_matrix = np.dot(chunk_embs, seg_embs.T)
    
    # Greedy monotonic assignment
    last_seg = 0
    chunk_assignments = []
    
    for ci in range(len(chunks)):
        search_start = max(0, last_seg - 2)
        best_idx = -1
        best_score = -1
        
        for si in range(search_start, n):
            score = float(sim_matrix[ci, si])
            # Distance penalty for big jumps
            jump = si - last_seg
            if jump > 5:
                score *= 0.9
            if jump > 10:
                score *= 0.85
            if score > best_score:
                best_score = score
                best_idx = si
        
        raw_score = float(sim_matrix[ci, best_idx]) if best_idx >= 0 else 0
        
        if raw_score >= 0.3 and best_idx >= max(0, last_seg - 2):
            if best_idx > last_seg:
                last_seg = best_idx
            chunk_assignments.append(max(best_idx, last_seg))
        else:
            chunk_assignments.append(last_seg)
    
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
    
    # Fill gaps by interpolation
    for i in range(n):
        if seg_time_ranges[i] is None:
            prev_idx, prev_end = None, None
            next_idx, next_start = None, None
            for j in range(i-1, -1, -1):
                if seg_time_ranges[j]:
                    prev_idx, prev_end = j, seg_time_ranges[j]['end']
                    break
            for j in range(i+1, n):
                if seg_time_ranges[j]:
                    next_idx, next_start = j, seg_time_ranges[j]['start']
                    break
            if prev_idx is not None and next_idx is not None:
                gap = next_start - prev_end
                spans = next_idx - prev_idx
                off = i - prev_idx
                seg_time_ranges[i] = {
                    'start': prev_end + gap * (off - 0.5) / spans,
                    'end': prev_end + gap * (off + 0.5) / spans
                }
            elif prev_idx is not None:
                seg_time_ranges[i] = {'start': prev_end, 'end': prev_end + 0.5}
            elif next_idx is not None:
                seg_time_ranges[i] = {'start': max(0, next_start - 0.5), 'end': next_start}
            else:
                seg_time_ranges[i] = {'start': 0, 'end': cues[-1]['end']}
    
    # Make continuous
    for i in range(1, n):
        if seg_time_ranges[i]['start'] > seg_time_ranges[i-1]['end']:
            mid = (seg_time_ranges[i-1]['end'] + seg_time_ranges[i]['start']) / 2
            seg_time_ranges[i-1]['end'] = mid
            seg_time_ranges[i]['start'] = mid
        elif seg_time_ranges[i]['start'] < seg_time_ranges[i-1]['end']:
            seg_time_ranges[i]['start'] = seg_time_ranges[i-1]['end']
    
    seg_time_ranges[0]['start'] = 0
    seg_time_ranges[-1]['end'] = cues[-1]['end']
    
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
