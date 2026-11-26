#!/usr/bin/env python3
"""產生睡眠日記圖示:24 小時時鐘環(睡眠/醒來/白天)+ 中心新月。
輸出:android/icon/icon.svg、Android 向量資源、網頁標題列 logo 與 favicon。
之後再用 Playwright 由 icon.svg 輸出各尺寸 PNG(見 android/icon/README.md)。
用法(在專案根目錄):python3 android/icon/generate_icon.py
"""
import math, re

CX = CY = 54.0
def P(r, deg): t = math.radians(deg); return (CX + r*math.sin(t), CY - r*math.cos(t))
def sector(R, r, a0, a1, inset=0.9, gapdeg=1.4):
    """環形扇形(12 點鐘方向為 0°,順時針)。內縮 inset 並配合同色描邊 → 圓角效果。"""
    R2, r2 = R - inset, r + inset
    d0 = a0 + math.degrees(inset / R2) + gapdeg/2; d1 = a1 - math.degrees(inset / R2) - gapdeg/2
    if d1 <= d0: return ''
    p1, p2, p3, p4 = P(R2, d0), P(R2, d1), P(r2, d1), P(r2, d0)
    large = 1 if (d1 - d0) > 180 else 0
    return (f"M{p1[0]:.2f},{p1[1]:.2f} A{R2:.2f},{R2:.2f} 0 {large},1 {p2[0]:.2f},{p2[1]:.2f} "
            f"L{p3[0]:.2f},{p3[1]:.2f} A{r2:.2f},{r2:.2f} 0 {large},0 {p4[0]:.2f},{p4[1]:.2f} Z")

h2d = lambda h: h / 24 * 360
R, r = 33.0, 21.0
SLEEP, AWAKE, DAY, MOON = '#7C93FF', '#FFB347', '#FFE29A', '#FFF6DC'
BG0, BG1 = '#4A3CB4', '#121850'
# (顏色, 起始小時, 結束小時):睡眠 22:30→06:30(含兩次醒來),白天 07:00→22:00
SEGS = [(SLEEP, 22.5, 1.0), (AWAKE, 1.0, 2.1), (SLEEP, 2.1, 3.4), (AWAKE, 3.4, 4.3), (SLEEP, 4.3, 6.5), (DAY, 7.0, 22.0)]
paths = []
for col, a, b in SEGS:
    a0, a1 = h2d(a), h2d(b)
    if a1 <= a0: a1 += 360
    d = sector(R, r, a0, a1)
    if d: paths.append((col, d))

def inter(a, b):
    (x0, y0, r0), (x1, y1, r1) = a, b; dd = math.hypot(x1-x0, y1-y0)
    aa = (r0*r0 - r1*r1 + dd*dd) / (2*dd); h = math.sqrt(r0*r0 - aa*aa)
    xm, ym = x0 + aa*(x1-x0)/dd, y0 + aa*(y1-y0)/dd
    return (xm + h*(y1-y0)/dd, ym - h*(x1-x0)/dd), (xm - h*(y1-y0)/dd, ym + h*(x1-x0)/dd)
c1 = (52.2, 55.6, 9.6); c2 = (57.4, 52.0, 8.2)
pa, pb = inter(c1, c2); ang = lambda c, p: math.atan2(p[1]-c[1], p[0]-c[0])
def arc(c, pf, pt, other, inside):
    a0, a1 = ang(c, pf), ang(c, pt)
    for sweep in (1, 0):
        span = (a1 - a0) % (2*math.pi) if sweep else (a0 - a1) % (2*math.pi)
        mid = a0 + span/2 if sweep else a0 - span/2
        mp = (c[0] + c[2]*math.cos(mid), c[1] + c[2]*math.sin(mid))
        if (math.hypot(mp[0]-other[0], mp[1]-other[1]) < other[2]) == inside:
            return f"A{c[2]:.2f},{c[2]:.2f} 0 {1 if span > math.pi else 0},{sweep} {pt[0]:.2f},{pt[1]:.2f}"
moon = f"M{pa[0]:.2f},{pa[1]:.2f} " + arc(c1, pa, pb, c2, False) + " " + arc(c2, pb, pa, c1, True) + " Z"

STROKE = 1.8
body = ''.join(f'<path d="{d}" fill="{c}" stroke="{c}" stroke-width="{STROKE}" stroke-linejoin="round"/>' for c, d in paths) + f'<path d="{moon}" fill="{MOON}"/>'
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="512" height="512">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="108" y2="108" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="{BG0}"/><stop offset="1" stop-color="{BG1}"/></linearGradient></defs>
  <rect width="108" height="108" fill="url(#bg)"/>
  {body}
</svg>'''
open('android/icon/icon.svg', 'w').write(svg)

res = 'android/app/src/main/res/drawable'
def vec(mono=False):
    out = '<?xml version="1.0" encoding="utf-8"?>\n<vector xmlns:android="http://schemas.android.com/apk/res/android"\n    android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">\n'
    for c, d in paths:
        col = '#000000' if mono else c
        out += f'    <path android:fillColor="{col}" android:strokeColor="{col}" android:strokeWidth="{STROKE}" android:strokeLineJoin="round" android:pathData="{d}"/>\n'
    return out + f'    <path android:fillColor="{"#000000" if mono else MOON}" android:pathData="{moon}"/>\n</vector>\n'
open(f'{res}/ic_launcher_foreground.xml', 'w').write(vec())
open(f'{res}/ic_launcher_monochrome.xml', 'w').write(vec(True))
bgx = open(f'{res}/ic_launcher_background.xml').read()
cols = iter([BG0, BG1]); bgx = re.sub(r'android:color="#[0-9A-Fa-f]{6}"', lambda m: f'android:color="{next(cols)}"', bgx)
open(f'{res}/ic_launcher_background.xml', 'w').write(bgx)

idx = open('sleep-diary/index.html').read()
logo = ('<svg viewBox="0 0 108 108" width="32" height="32" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="108" y2="108" gradientUnits="userSpaceOnUse">'
        f'<stop offset="0" stop-color="{BG0}"/><stop offset="1" stop-color="{BG1}"/></linearGradient></defs><rect width="108" height="108" rx="26" fill="url(#lg)"/>{body}</svg>')
idx = re.sub(r'<span class="logo">.*?</span><div class="ht">', lambda m: f'<span class="logo">{logo}</span><div class="ht">', idx, flags=re.S)
fav = 'data:image/svg+xml,' + re.sub(r'\s+width="512" height="512"', '', svg).replace('#', '%23').replace('"', "'").replace('\n', '').replace('  ', '')
idx = re.sub(r'<link rel="icon" href="[^"]*">', lambda m: f'<link rel="icon" href="{fav}">', idx)
open('sleep-diary/index.html', 'w').write(idx)
print('segments:', len(paths))
