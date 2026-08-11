#!/usr/bin/env python3
"""Render single frames of feed.html as store-ready 1280x800 PNGs.

The demo timeline is 660 frames (22s @ 30fps); pass the moments you want:
    python3 shot.py 330 460 655
    python3 shot.py --no-cursor 330      # drop the pointer when it isn't on a control
Frames land in demo/shots/. Renders at 2x then downsamples, so text stays crisp.
"""
import sys, pathlib, subprocess
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
URL = (HERE / "feed.html").as_uri()
SHOTS = HERE / "shots"
W, H = 1280, 800
TOTAL = 660  # keep in sync with render.py's default (22s * 30fps)

def main():
    args = sys.argv[1:]
    hide_cursor = "--no-cursor" in args
    frames = [int(a) for a in args if not a.startswith("-")] or [330, 460, 655]
    SHOTS.mkdir(exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=True,
                                     args=["--force-color-profile=srgb", "--hide-scrollbars"])
        page = browser.new_page(viewport={"width": W, "height": H}, device_scale_factor=2)
        page.goto(URL)
        page.wait_for_function("window.__ready === true")
        for f in frames:
            page.evaluate("([f,n]) => window.renderFrame(f,n)", [f, TOTAL])
            if hide_cursor:
                page.evaluate("document.querySelectorAll('.cursor,.ring')"
                              ".forEach(e => e.style.opacity = '0')")
            out = SHOTS / f"shot-{f:04d}.png"
            page.screenshot(path=str(out))
            # 2x -> exact store dimensions
            subprocess.run(["sips", "-z", str(H), str(W), str(out)],
                           check=True, capture_output=True)
            print(f"{out}  ({W}x{H})")
        browser.close()

if __name__ == "__main__":
    main()
