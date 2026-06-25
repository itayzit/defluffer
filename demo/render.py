#!/usr/bin/env python3
"""Render feed.html's deterministic animation to PNG frames using headless Chrome.
Drives its own Chrome instance (channel='chrome') — does not touch the user's browser."""
import sys, pathlib
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
URL = (HERE / "feed.html").as_uri()
FRAMES = HERE / "frames"
W, H = 1240, 780
FPS = 30
SECONDS = float(sys.argv[1]) if len(sys.argv) > 1 else 15.0
N = int(FPS * SECONDS)

def main():
    FRAMES.mkdir(exist_ok=True)
    for old in FRAMES.glob("*.png"):
        old.unlink()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=True,
                                     args=["--force-color-profile=srgb", "--hide-scrollbars"])
        page = browser.new_page(viewport={"width": W, "height": H}, device_scale_factor=2)
        page.goto(URL)
        page.wait_for_function("window.__ready === true")
        for i in range(N):
            page.evaluate("([f,n]) => window.renderFrame(f,n)", [i, N])
            page.screenshot(path=str(FRAMES / f"f{i:04d}.png"))
            if i % 30 == 0:
                print(f"frame {i}/{N}", flush=True)
        browser.close()
    print(f"done: {N} frames in {FRAMES}")

if __name__ == "__main__":
    main()
