"""Copies the shared web interface into the iOS app (run from the repo root)."""
import re, shutil, sys, pathlib
src = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path('../stealth/renderer')
dst = pathlib.Path('Stealth/Web')
if dst.exists(): shutil.rmtree(dst)
shutil.copytree(src, dst, ignore=shutil.ignore_patterns('icon.ico', 'manifest.webmanifest'))
html = (dst / 'index.html').read_text()
html = re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]*>\n?', '', html)   # file:// pages: no CSP needed
html = re.sub(r'<link rel="manifest"[^>]*>', '', html)
(dst / 'index.html').write_text(html)
print('Web copied:', sum(1 for _ in dst.rglob('*') if _.is_file()), 'files')
