#!/usr/bin/env python3
"""Compatibility entry point; the transactional installer owns deployment."""
import pathlib
import subprocess
import sys

raise SystemExit(subprocess.call([
    sys.executable, str(pathlib.Path(__file__).with_name('maintain.py')), 'install', *sys.argv[1:]
]))
