"""Retake the README screenshots (media/screenshots/) from the demo.

Not needed on the Pi. On a PC with Google Chrome (or Edge: --browser msedge):

    pip install playwright
    python server.py --demo --port 8097 --log-dir none     # in one terminal
    python tools/screenshots.py                             # in another

Takes a phone (iPhone 14 size) and a desktop (1920x1080) set in night mode: the dashboard, the 3D
view on the phone, the Console and Settings tabs, the Planing and System pages; and the desktop
dashboard in day mode.
"""
import argparse
import os

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PI_FOLDER = "/home/mekanika/Desktop"  # typed into Settings > Files instead of this PC's folder (not saved)

ap = argparse.ArgumentParser()
ap.add_argument("--url", default="http://localhost:8097")
ap.add_argument("--out", default=os.path.join(HERE, "..", "media", "screenshots"))
ap.add_argument("--browser", default="chrome", help="chrome or msedge")
args = ap.parse_args()
os.makedirs(args.out, exist_ok=True)


def shot(page, name):
    page.screenshot(path=os.path.join(args.out, name + ".png"))


with sync_playwright() as p:
    browser = p.chromium.launch(channel=args.browser)

    def open_page(path="/", theme="dark", **context):
        ctx = browser.new_context(**context)
        ctx.add_init_script(f"try {{ localStorage.setItem('theme', '{theme}') }} catch (e) {{}}")
        page = ctx.new_page()
        page.goto(args.url + path, wait_until="domcontentloaded")
        page.wait_for_timeout(7000)  # demo job running, 3D view drawn
        return page

    def open_tab(page, name, scroll=False):
        page.click(f'.ptab[data-ptab="{name}"]')
        if name == "settings":
            page.fill("#filesDirInput", PI_FOLDER)
        page.wait_for_timeout(1500)
        if scroll:  # phone: bring the tab panel into view
            page.evaluate("document.getElementById('sidePanel').scrollIntoView({block: 'start'})")
            page.wait_for_timeout(500)

    phone = dict(p.devices["iPhone 14"], device_scale_factor=2)
    page = open_page(**phone)
    shot(page, "mobile")
    page.evaluate("document.querySelector('.view-panel').scrollIntoView({block: 'start'})")
    page.wait_for_timeout(800)
    shot(page, "mobile-3d")
    for tab in ("console", "settings"):
        open_tab(page, tab, scroll=True)
        shot(page, "mobile-" + tab)

    desk = {"viewport": {"width": 1920, "height": 1080}}
    page = open_page(**desk)
    shot(page, "desktop")
    for tab in ("console", "settings"):
        open_tab(page, tab)
        shot(page, "desktop-" + tab)
    shot(open_page("/planing", **desk), "desktop-planing")
    shot(open_page("/system", **desk), "desktop-system")
    shot(open_page(theme="light", **desk), "desktop-day")

    browser.close()
print("screenshots written to", os.path.abspath(args.out))
