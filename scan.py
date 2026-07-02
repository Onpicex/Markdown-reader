#!/usr/bin/env python3
"""
Lightweight catalog scanner for Obsidian Reader.
Only scans directory structure + extracts titles from frontmatter/headings.
No markdown-to-HTML conversion — the frontend handles rendering at runtime.
"""

import json
import re
import sys
import os
from pathlib import Path
from typing import Optional, List, Tuple

try:
    import yaml
except ImportError:
    # Do NOT auto-install at import time: the server calls this with a 30s
    # timeout, a network pip install can blow that budget and leave a
    # half-installed state. Fail fast and let the deploy env pre-install it.
    print(
        f"❌ Missing dependency 'pyyaml'. Install it once: "
        f"{sys.executable} -m pip install --user pyyaml",
        file=sys.stderr,
    )
    sys.exit(1)

# ── Configuration ──────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent
CONFIG_PATH = SCRIPT_DIR / "config.json"
DIST_DIR = SCRIPT_DIR / "dist"
DATA_DIR = DIST_DIR / "data"

# Read vault path from config.json. No hardcoded fallback: a missing/broken
# config must fail loudly here, matching server.js which refuses to serve
# vault files in the same situation (previously the two disagreed — scan
# fell back to a baked-in path and produced a full catalog of 404s).
def _load_vault_path():
    try:
        cfg = json.load(open(CONFIG_PATH))
    except FileNotFoundError:
        print(f"❌ config.json not found at {CONFIG_PATH}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"❌ config.json unreadable: {e}", file=sys.stderr)
        sys.exit(1)
    vault = str(cfg.get("vault", "")).strip()
    if not vault:
        print("❌ config.json has no 'vault' path", file=sys.stderr)
        sys.exit(1)
    return Path(vault)

VAULT_PATH = _load_vault_path()
RAW_DIR = VAULT_PATH / "raw"
WIKI_DIR = VAULT_PATH / "wiki"

# Meta/index filenames treated as course-level noise. These are skipped ONLY
# when they live inside a subdirectory (e.g. raw/某课程/index.md); the same
# names sitting directly at a section root (wiki/index.md, wiki/log.md) are
# real content the user wants to read, so they are kept — see scan_directory.
SKIP_FILENAMES = {
    "README.md", "readme.md", "index.md", "log.md",
    "lint-report.md", "_metadata.json", "_column-info.json",
}

TOP_SECTIONS = {
    "raw": "📂 Raw",
    "wiki": "📚 Wiki",
}


def parse_frontmatter(content: str) -> Tuple[dict, str]:
    """Parse YAML frontmatter. Returns (metadata, body)."""
    content = content.lstrip('\ufeff')
    if not content.startswith('---'):
        return {}, content

    end_match = re.search(r'\n---\s*\n', content[3:])
    if not end_match:
        end_match = re.search(r'\n---\s*$', content[3:])
        if not end_match:
            return {}, content

    fm_text = content[3:3 + end_match.start()]
    body = content[3 + end_match.end():]

    try:
        meta = yaml.safe_load(fm_text)
        if not isinstance(meta, dict):
            meta = {}
    except yaml.YAMLError:
        meta = {}

    return meta, body


def extract_title(meta: dict, body: str, filename: str) -> str:
    """Extract title from frontmatter, first heading, or filename.
    If filename starts with a number prefix (e.g. 001_xxx.md),
    the prefix is prepended to the title for ordering."""
    # Detect numeric prefix in filename: 001_xxx.md → prefix="001".
    # Accept common separators incl. fullwidth space and CJK bars/dots so
    # platform-style names ("19.0726丨03 ...", "001、xxx") still order correctly.
    name = filename.replace('.md', '')
    prefix_match = re.match(r'^(\d+)[_.\s　丨．、|]', name)
    prefix = prefix_match.group(1) if prefix_match else None

    # Get base title from frontmatter or H1
    title = None
    if meta.get('title'):
        title = str(meta['title']).strip()
    else:
        h1_match = re.search(r'^#\s+(.+)$', body, re.MULTILINE)
        if h1_match:
            title = h1_match.group(1).strip()

    if title:
        # Prepend number prefix if present and title doesn't already start with it
        if prefix and not re.match(r'^\d+[_.\s]', title):
            title = f"{prefix} {title}"
        return title

    # Fallback: use filename. Only strip a trailing "-author" slug when the
    # name looks like a slug (single hyphen, no spaces) — avoids mangling real
    # titles that legitimately contain a spaced hyphen ("初段 - 闭环").
    if '-' in name and name.count('-') == 1 and ' ' not in name:
        parts = name.rsplit('-', 1)
        if 0 < len(parts[1]) < 20 and not re.search(r'\d', parts[1]):
            return parts[0]
    return name


def _jsonable(v):
    """Coerce a frontmatter value to a JSON-safe equivalent, recursively."""
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, list):
        return [_jsonable(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    return str(v)


def get_subcategory(rel_path: str) -> str:
    """Extract subcategory from path — all intermediate directory levels.
    
    For rel_path like 'raw/A/B/C/file.md', parts = ['raw','A','B','C','file.md']
    subcategory = 'A/B/C' (everything between the top-level dir and the filename)
    """
    parts = rel_path.split('/')
    # parts[0] = top-level dir (raw/wiki), parts[-1] = filename
    # subcategory = everything in between
    if len(parts) >= 3:
        return '/'.join(parts[1:-1])
    return ""


def _walk_md_files(base_dir: Path, failed_dirs: List[Path]) -> List[Path]:
    """Collect *.md under base_dir, tolerating per-directory OSErrors.

    iCloud throws transient `OSError: [Errno 11] Resource deadlock avoided`
    while a course directory is syncing (46 such aborts in production logs).
    A plain rglob() lets that single locked subtree kill the whole scan;
    here the failed directory is recorded and skipped instead — the caller
    backfills its entries from the previous catalog so an in-flight sync
    never makes an already-catalogued course vanish from the sidebar.
    """
    md_files = []

    def onerror(err):
        d = Path(getattr(err, 'filename', None) or base_dir)
        failed_dirs.append(d)
        print(f"  ⚠️  Unreadable directory (kept from old catalog): {d}: {err}", file=sys.stderr)

    for dirpath, dirnames, filenames in os.walk(base_dir, onerror=onerror):
        dirnames[:] = [d for d in dirnames if not d.startswith('.') and d != 'assets']
        for name in filenames:
            if name.endswith('.md') and not name.startswith('.'):
                md_files.append(Path(dirpath) / name)
    return sorted(md_files)


def scan_directory(base_dir: Path, prefix: str, failed_prefixes: List[str]) -> List[dict]:
    """Scan directory for markdown files, extract titles only (no HTML conversion)."""
    articles = []
    if not base_dir.exists():
        print(f"  ⚠️  Directory not found: {base_dir}")
        return articles

    failed_dirs: List[Path] = []
    md_files = _walk_md_files(base_dir, failed_dirs)
    for d in failed_dirs:
        try:
            rel = d.relative_to(base_dir)
            # relative_to(self) is Path('.'), NOT a ValueError — without this
            # a failure on base_dir itself produced the prefix "raw/." which
            # matches no article id, silently dropping the whole section.
            failed_prefixes.append(prefix if str(rel) == '.' else f"{prefix}/{rel}")
        except ValueError:
            failed_prefixes.append(prefix)  # error above base_dir itself
    for filepath in md_files:
        rel_parts = filepath.relative_to(base_dir).parts
        # Skip meta/index files only when nested in a subdirectory (course-level
        # noise). Files directly at the section root are always kept.
        if filepath.name in SKIP_FILENAMES and len(rel_parts) > 1:
            continue

        rel_to_base = str(filepath.relative_to(base_dir))
        rel_path = f"{prefix}/{rel_to_base}"

        try:
            content = filepath.read_text(encoding='utf-8')
        except (UnicodeDecodeError, OSError) as e:
            print(f"  ⚠️  Skipping {rel_path}: {e}")
            continue

        if len(content.strip()) < 10:
            continue

        meta, body = parse_frontmatter(content)
        title = extract_title(meta, body, filepath.name)
        category = TOP_SECTIONS.get(prefix, "📁 其他")
        subcategory = get_subcategory(rel_path)

        # Clean meta for JSON. Must be recursive: yaml.safe_load turns an
        # unquoted `2026-01-01` into datetime.date, and a list was previously
        # admitted wholesale — one such value inside a list made json.dump
        # blow up on the WHOLE catalog. Bad meta degrades to {} per article.
        try:
            clean_meta = {str(k): _jsonable(v) for k, v in meta.items()}
        except Exception as e:
            print(f"  ⚠️  Bad frontmatter meta in {rel_path}, dropping meta: {e}", file=sys.stderr)
            clean_meta = {}

        articles.append({
            "id": rel_path,  # e.g. "raw/reading-app/书名.md" — doubles as fetch path
            "title": title,
            "category": category,
            "subcategory": subcategory,
            "meta": clean_meta,
        })

    return articles


def scan():
    """Main scan function — generates catalog.json only."""
    print("🔍 Scanning Obsidian vault...")
    print(f"   Vault: {VAULT_PATH}")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    catalog_path = DATA_DIR / "catalog.json"

    failed_prefixes: List[str] = []

    print("\n📂 Scanning raw/...")
    raw_articles = scan_directory(RAW_DIR, "raw", failed_prefixes)
    print(f"   Found {len(raw_articles)} articles")

    print("\n📂 Scanning wiki/...")
    wiki_articles = scan_directory(WIKI_DIR, "wiki", failed_prefixes)
    print(f"   Found {len(wiki_articles)} articles")

    all_articles = raw_articles + wiki_articles

    # Backfill subtrees that errored mid-walk (iCloud sync lock) from the
    # previous catalog, so their already-known articles stay in the sidebar
    # instead of vanishing until the directory becomes readable again.
    if failed_prefixes:
        seen_ids = {a["id"] for a in all_articles}
        restored = 0
        try:
            old_articles = json.load(open(catalog_path, encoding='utf-8')).get("articles", [])
        except Exception:
            old_articles = []
        for a in old_articles:
            aid = a.get("id", "")
            if aid in seen_ids:
                continue
            if any(aid == p or aid.startswith(p + "/") for p in failed_prefixes):
                all_articles.append(a)
                seen_ids.add(aid)
                restored += 1
        print(f"\n♻️  Restored {restored} articles from old catalog for {len(failed_prefixes)} unreadable dir(s)")

    print(f"\n📊 Total: {len(all_articles)} articles")

    if len(all_articles) == 0:
        print("\n⚠️  No articles found! Vault may not be mounted. Skipping write.")
        return

    categories = {}
    for a in all_articles:
        cat = a["category"]
        categories[cat] = categories.get(cat, 0) + 1

    print("\n📋 Categories:")
    for cat, count in sorted(categories.items()):
        print(f"   {cat}: {count}")

    # Sort
    def sort_key(a):
        section = 0 if a["id"].startswith("raw") else 1
        return (section, a["category"], a.get("subcategory", ""), a["title"])

    all_articles.sort(key=sort_key)

    catalog = {
        "categories": sorted(categories.keys()),
        "totalArticles": len(all_articles),
        "articles": all_articles,
    }

    # Compact separators halve the payload vs indent=2 (914KB → ~440KB);
    # default=str is a last-resort guard so one weird value can never again
    # abort catalog generation.
    payload = json.dumps(catalog, ensure_ascii=False, separators=(',', ':'), default=str)

    # Unchanged content → don't touch the file. Keeping mtime stable keeps
    # the mtime-derived ETag stable, so clients get 304s instead of refetching
    # 900KB every 5-minute safety-net rescan; server.js also uses the mtime
    # to decide whether to broadcast catalog-updated.
    # UnicodeDecodeError included: a truncated legacy catalog (the very thing
    # the old non-atomic write could leave behind) must fall through to the
    # rewrite below, not crash the scan forever.
    try:
        if catalog_path.read_text(encoding='utf-8') == payload:
            print(f"\n✅ Scan complete — catalog unchanged, skipping write")
            return
    except (OSError, UnicodeDecodeError):
        pass

    # Atomic write: readers never see a half-written file, and a SIGTERM
    # (server-side 30s exec timeout) can no longer leave a truncated catalog.
    tmp_path = catalog_path.with_name(f"catalog.json.tmp{os.getpid()}")
    try:
        tmp_path.write_text(payload, encoding='utf-8')
        os.replace(tmp_path, catalog_path)
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass

    print(f"\n✅ Scan complete! Catalog: {catalog_path}")


if __name__ == "__main__":
    scan()
