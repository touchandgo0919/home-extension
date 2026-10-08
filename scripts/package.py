"""Package only extension runtime files; never include credentials or test data."""
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / "manifest.json").read_text())
files = ["manifest.json", "background.js", "popup.html", "popup.js", "popup.css", "i18n.js"]
files += [f"icons/{size}.png" for size in (16, 32, 48, 128)]
files += [str(path.relative_to(root)) for path in sorted((root / "_locales").rglob("*.json"))]
for name in files:
    if not (root / name).is_file():
        raise SystemExit(f"Missing runtime file: {name}")
output = root / "dist" / f"home-navigation-chrome-{manifest['version']}.zip"
output.parent.mkdir(exist_ok=True)
with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
    for name in files:
        archive.write(root / name, name)
print(output)
