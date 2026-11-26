"""A local page for sorting every indexed slide into a kind, one keypress each.

    python3 sort.py [out] [--port 8765]     then open http://localhost:8765

Reads out/catalogue.jsonl and out/thumbs/ (from index.py and render.py). Each choice is
appended to out/labels.jsonl as it is made, so the page can be closed and reopened at any
point; the latest choice for a slide wins. "Export" (or `python3 sort.py out --export`)
writes out/catalogue-labelled.jsonl, every slide with its confirmed kind and item count, and
rebuilds out/sorted/<kind>/<items>/ with each sorted slide's thumbnail, to browse in Finder.
"""

import argparse
import json
import os
import shutil
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from kinds import KIND_NAMES, KINDS  # noqa: E402


class Store:
    def __init__(self, out):
        self.out = out
        self.slides = [json.loads(line) for line in (out / "catalogue.jsonl").read_text(encoding="utf8").splitlines()]
        self.by_id = {slide["id"]: slide for slide in self.slides}
        self.labels_path = out / "labels.jsonl"
        self.labels = {}
        if self.labels_path.exists():
            for line in self.labels_path.read_text(encoding="utf8").splitlines():
                entry = json.loads(line)
                self.labels[entry["id"]] = entry

    def decks(self):
        decks = {}
        for slide in self.slides:
            deck = decks.setdefault(slide["deck"], {
                "deck": slide["deck"], "pack": slide["pack"], "topic": slide["topic"],
                "named": slide["guess"] if slide["confidence"] == "name" else None, "total": 0, "done": 0,
            })
            deck["total"] += 1
            deck["done"] += slide["id"] in self.labels
        return list(decks.values())

    def deck_slides(self, deck):
        return [
            {
                "id": s["id"], "slide": s["slide"], "guess": s["guess"], "confidence": s["confidence"],
                "hint": s["shape_guess"], "items": s["items"], "label": self.labels.get(s["id"]),
                "thumb": f"/thumbs/{s['deck']}/{s['slide']:03d}.png",
            }
            for s in self.slides if s["deck"] == deck
        ]

    def label(self, entries):
        lines = []
        for entry in entries:
            if entry.get("id") not in self.by_id or entry.get("kind") not in KIND_NAMES:
                raise ValueError(f"bad label: {entry}")
            items = entry.get("items")
            clean = {"id": entry["id"], "kind": entry["kind"], "items": int(items) if items else None}
            self.labels[clean["id"]] = clean
            lines.append(json.dumps(clean) + "\n")
        with open(self.labels_path, "a", encoding="utf8") as handle:
            handle.writelines(lines)

    def export(self):
        path = self.out / "catalogue-labelled.jsonl"
        folders = self.out / "sorted"
        if folders.exists():
            shutil.rmtree(folders)
        counts = {}
        with open(path, "w", encoding="utf8") as handle:
            for slide in self.slides:
                label = self.labels.get(slide["id"])
                if not label:
                    continue
                items = label["items"] or slide["items"]
                counts[label["kind"]] = counts.get(label["kind"], 0) + 1
                handle.write(json.dumps({**slide, "kind": label["kind"], "items": items}, ensure_ascii=False) + "\n")
                self.file_thumbnail(slide, folders / label["kind"] / (f"{items} items" if items else "other"))
        return {"path": str(path), "folders": str(folders), "labelled": len(self.labels), "total": len(self.slides), "kinds": counts}

    def file_thumbnail(self, slide, folder):
        """Link (or, across disks, copy) the slide's thumbnail into its kind's folder."""
        source = self.out / "thumbs" / slide["deck"] / f"{slide['slide']:03d}.png"
        if not source.exists():
            return
        folder.mkdir(parents=True, exist_ok=True)
        name = slide["id"].replace("-powerpoint-infographics", "")
        target = folder / f"{name}.png"
        try:
            os.link(source, target)
        except OSError:
            shutil.copyfile(source, target)


def make_handler(store):
    page = (HERE / "sort.html").read_bytes()
    thumbs = (store.out / "thumbs").resolve()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, body, kind="application/json", status=HTTPStatus.OK):
            if not isinstance(body, bytes):
                body = json.dumps(body, ensure_ascii=False).encode("utf8")
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "max-age=3600" if kind == "image/png" else "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            url = urlparse(self.path)
            if url.path == "/":
                return self.send(page, "text/html; charset=utf-8")
            if url.path == "/api/decks":
                return self.send({"kinds": [{"name": n, "key": k, "use": u} for n, k, u in KINDS], "decks": store.decks()})
            if url.path == "/api/slides":
                return self.send(store.deck_slides(parse_qs(url.query).get("deck", [""])[0]))
            if url.path.startswith("/thumbs/"):
                file = (thumbs / url.path.removeprefix("/thumbs/")).resolve()
                if file.is_relative_to(thumbs) and file.is_file():
                    return self.send(file.read_bytes(), "image/png")
                return self.send({"error": "no thumbnail yet"}, status=HTTPStatus.NOT_FOUND)
            return self.send({"error": "not found"}, status=HTTPStatus.NOT_FOUND)

        def do_POST(self):
            url = urlparse(self.path)
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            try:
                if url.path == "/api/label":
                    store.label(body if isinstance(body, list) else [body])
                    return self.send({"ok": True})
                if url.path == "/api/export":
                    return self.send(store.export())
            except ValueError as error:
                return self.send({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
            return self.send({"error": "not found"}, status=HTTPStatus.NOT_FOUND)

    return Handler


def main(argv):
    parser = argparse.ArgumentParser(description="Sort indexed slides by kind.")
    parser.add_argument("out", nargs="?", type=Path, default=HERE / "out")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--export", action="store_true", help="write catalogue-labelled.jsonl and exit")
    args = parser.parse_args(argv)
    store = Store(args.out)
    if args.export:
        print(json.dumps(store.export(), indent=1))
        return 0
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(store))
    print(f"sorting {len(store.slides)} slides ({len(store.labels)} done) at http://localhost:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
