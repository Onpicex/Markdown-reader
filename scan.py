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

# Read vault path from config.json if present
def _load_vault_path():
    if CONFIG_PATH.exists():
        try:
            cfg = json.load(open(CONFIG_PATH))
            return Path(cfg.get("vault", ""))
        except Exception:
            pass
    return Path("/Users/lhx/Library/Mobile Documents/iCloud~md~obsidian/Documents/Openclaw")

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


def scan_directory(base_dir: Path, prefix: str) -> List[dict]:
    """Scan directory for markdown files, extract titles only (no HTML conversion)."""
    articles = []
    if not base_dir.exists():
        print(f"  ⚠️  Directory not found: {base_dir}")
        return articles

    md_files = sorted(base_dir.rglob("*.md"))
    for filepath in md_files:
        if any(part.startswith('.') for part in filepath.parts):
            continue
        if 'assets' in filepath.parts:
            continue
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

        # Clean meta for JSON
        clean_meta = {}
        for k, v in meta.items():
            if isinstance(v, (str, int, float, bool, list)):
                clean_meta[k] = v
            else:
                clean_meta[k] = str(v)

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

    print("\n📂 Scanning raw/...")
    raw_articles = scan_directory(RAW_DIR, "raw")
    print(f"   Found {len(raw_articles)} articles")

    print("\n📂 Scanning wiki/...")
    wiki_articles = scan_directory(WIKI_DIR, "wiki")
    print(f"   Found {len(wiki_articles)} articles")

    all_articles = raw_articles + wiki_articles
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

    catalog_path = DATA_DIR / "catalog.json"
    with open(catalog_path, 'w', encoding='utf-8') as f:
        json.dump(catalog, f, ensure_ascii=False, indent=2)

    print(f"\n✅ Scan complete! Catalog: {catalog_path}")


if __name__ == "__main__":
    scan()
