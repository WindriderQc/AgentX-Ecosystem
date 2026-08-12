#!/usr/bin/env python3
"""
MD Documentation Packer

Recursively scans a source directory for .md files and packs them into a ZIP archive
while preserving the relative directory structure.

Usage: python3 pack_md_docs.py <source_dir> <output_zip>
"""

import os
import sys
import zipfile
from pathlib import Path

def should_skip_dir(dir_name):
    """Check if directory should be skipped during scanning."""
    skip_dirs = {
        'node_modules', '.git', '.vscode', '__pycache__', 'build', 'dist',
        'coverage', 'logs', 'tmp', 'temp', '.next', '.nuxt'
    }
    return dir_name in skip_dirs or dir_name.startswith('.')

def collect_md_files(source_dir):
    """Recursively collect all .md files with their relative paths."""
    md_files = []
    source_path = Path(source_dir)

    for root, dirs, files in os.walk(source_path):
        # Filter out directories to skip
        dirs[:] = [d for d in dirs if not should_skip_dir(d)]

        for file in files:
            if file.lower().endswith('.md'):
                full_path = Path(root) / file
                rel_path = full_path.relative_to(source_path)
                md_files.append((str(full_path), str(rel_path)))

    return md_files

def pack_md_files(source_dir, output_zip):
    """Pack all MD files from source_dir into output_zip preserving hierarchy."""
    print(f"Scanning {source_dir} for .md files...")

    md_files = collect_md_files(source_dir)

    if not md_files:
        print("No .md files found.")
        return False

    print(f"Found {len(md_files)} .md files. Creating ZIP archive...")

    with zipfile.ZipFile(output_zip, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for full_path, rel_path in md_files:
            print(f"Adding: {rel_path}")
            zipf.write(full_path, rel_path)

    print(f"ZIP archive created: {output_zip}")
    return True

def main():
    if len(sys.argv) != 3:
        print("Usage: python3 pack_md_docs.py <source_dir> <output_zip>")
        sys.exit(1)

    source_dir = sys.argv[1]
    output_zip = sys.argv[2]

    if not os.path.isdir(source_dir):
        print(f"Error: Source directory '{source_dir}' does not exist.")
        sys.exit(1)

    success = pack_md_files(source_dir, output_zip)
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()