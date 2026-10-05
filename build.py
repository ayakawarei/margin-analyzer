#!/usr/bin/env python3
"""Inline local scripts into the standalone HTML, or verify its freshness."""
import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SCRIPTS = ('echarts.min.js', 'engine.js', 'engine2.js', 'official.js')
OUTPUT = ROOT / '日股信用残分析.html'


def bundle():
    html = (ROOT / 'index.html').read_text(encoding='utf-8')
    for name in SCRIPTS:
        marker = f'<script src="{name}"></script>'
        if html.count(marker) != 1:
            raise ValueError(f'Expected exactly one script reference: {name}')
        source = (ROOT / name).read_text(encoding='utf-8')
        source = source.replace('</script', '<\\/script')
        # Literal replacement preserves JavaScript dollar signs in vendor code.
        html = html.replace(marker, '<script>\n' + source + '\n</script>')
    return html


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Check without writing')
    args = parser.parse_args()
    html = bundle()
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text(encoding='utf-8') != html:
            raise SystemExit('Bundle is stale. Run: python3 build.py')
        print('Bundle matches all source files.')
    else:
        OUTPUT.write_text(html, encoding='utf-8')
        print(f'Built {OUTPUT.name} ({len(html.encode("utf-8")):,} bytes).')


if __name__ == '__main__':
    main()
