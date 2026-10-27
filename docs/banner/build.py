import math, random, base64, html
random.seed(3)
wf=base64.b64encode(open('wf.png','rb').read()).decode()

# --- TLE "database" text (real TLE layout, made-up values) ---
names=["ISS (ZARYA)","MAUVE","FUNCUBE-1 (AO-73)","SO-50","AO-91","RS-44","CAS-4A","XW-2B","LILACSAT-2","TEVEL-1","GREENCUBE","UVSQ-SAT","NAYIF-1","JY1SAT","PO-101","IO-117","SONATE-2","CUTE","FOSSASAT-2E","SMOG-1"]
def tle(n,norad):
    yr=random.choice([98,13,17,18,19,20,22,23,24]); epoch=f"26{random.uniform(290,300):012.8f}"
    l1=f"1 {norad:05d}U {yr:02d}{random.randint(1,99):03d}A   {epoch}  .{random.randint(1000,99999):08d}  00000-0  {random.randint(10000,99999)}-3 0  999{random.randint(0,9)}"
    l2=f"2 {norad:05d}  {random.uniform(40,99):7.4f} {random.uniform(0,360):8.4f} {random.randint(1000,9999999):07d} {random.uniform(0,360):8.4f} {random.uniform(0,360):8.4f} {random.uniform(14,16):11.8f}{random.randint(10000,99999)}"
    return [n,l1,l2]
lines=[]
for k in range(16):
    for i,n in enumerate(names):
        lines+=tle(n,random.choice([25544,66756,39444,27607,43017,44909,42761,40903,40908,51013,53106,47438,42017,43803,47963,53057,59112,49263,56973,59054]))
tl=[]
for i,l in enumerate(lines[:60]):
    bright = 'hl' if i in (9,10,11,33,34,35) else ''
    tl.append(f'<div class="{bright}">{html.escape(l)}</div>')
tle_html="".join(tl)

# --- the boy (seen from behind), the Yagi at 45 degrees, the phone on the boom ---
UX,UY=0.7071,-0.7071; NX,NY=0.7071,0.7071
BX,BY=790,400
def P(s, off=0.0):
    return (BX+s*UX+off*NX, BY+s*UY+off*NY)
def ln(a,b,**kw):
    attrs=" ".join(f'{k.replace("_","-")}="{v}"' for k,v in kw.items())
    return f'<line x1="{a[0]:.1f}" y1="{a[1]:.1f}" x2="{b[0]:.1f}" y2="{b[1]:.1f}" {attrs}/>'
el=[]
for s_,L,cls in [(70,158,'el'),(150,146,'drv'),(232,134,'el'),(316,126,'el'),(400,120,'el')]:
    if cls=='drv':
        el.append(ln(P(s_,-L/2),P(s_,-4),stroke="#d7dde4",stroke_width=5,stroke_linecap="round"))
        el.append(ln(P(s_,4),P(s_,L/2),stroke="#d7dde4",stroke_width=5,stroke_linecap="round"))
        el.append(f'<rect x="{P(s_)[0]-7:.1f}" y="{P(s_)[1]-7:.1f}" width="14" height="14" rx="3" fill="#2a3644" transform="rotate(-45 {P(s_)[0]:.1f} {P(s_)[1]:.1f})"/>')
    else:
        el.append(ln(P(s_,-L/2),P(s_,L/2),stroke="#d7dde4",stroke_width=5,stroke_linecap="round"))
    el.append(f'<circle cx="{P(s_)[0]:.1f}" cy="{P(s_)[1]:.1f}" r="5" fill="#9aa6b2"/>')
boom=ln(P(-45),P(440),stroke="#e9eef3",stroke_width=11,stroke_linecap="round")
boom_shade=ln(P(-45,3),P(440,3),stroke="#8794a3",stroke_width=4,stroke_linecap="round")
handle=ln(P(-45),P(55),stroke="#22303e",stroke_width=15,stroke_linecap="round")
c0=P(150); c1=P(128,16); c2=P(112,8)
coax=f'<path d="M{c0[0]:.1f},{c0[1]:.1f} Q{c1[0]:.1f},{c1[1]:.1f} {c2[0]:.1f},{c2[1]:.1f}" stroke="#111" stroke-width="4" fill="none"/>'
# phone across the boom, its back towards us (camera bump), clamped on
pc=P(105)
phone=f"""
<g transform="translate({pc[0]:.1f},{pc[1]:.1f}) rotate(45) scale(1.3)">
  <rect x="-47" y="-25" width="94" height="50" rx="8" fill="#0c1117" stroke="#4a5a6c" stroke-width="2"/>
  <rect x="-42" y="-21" width="84" height="42" rx="4" fill="#05080c"/>
  <!-- SatHunterSDR in landscape: nixie frequency, radar, waterfall -->
  <rect x="-40" y="-19" width="38" height="9" rx="1.5" fill="#1a0f08"/>
  <text x="-21" y="-12.2" text-anchor="middle" font-family="DejaVu Sans Mono,monospace" font-size="7.2" fill="#ff9a3c" style="filter:drop-shadow(0 0 1.5px #ff5a00)">435.800</text>
  <g transform="translate(-21,6)">
    <circle r="12" fill="#06140d" stroke="#2fd47a" stroke-width="1.2"/>
    <circle r="6.5" fill="none" stroke="#2fd47a" stroke-width=".8" opacity=".7"/>
    <line x1="-12" y1="0" x2="12" y2="0" stroke="#2fd47a" stroke-width=".6" opacity=".6"/>
    <line x1="0" y1="-12" x2="0" y2="12" stroke="#2fd47a" stroke-width=".6" opacity=".6"/>
    <path d="M-8,7 Q-1,-11 9,-3" stroke="#ffc83c" stroke-width="1.3" fill="none"/>
    <circle cx="4.5" cy="-5.5" r="2.3" fill="#ffc83c"/>
  </g>
  <defs><linearGradient id="pwf" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#0d2a7a"/><stop offset=".45" stop-color="#1550c0"/><stop offset=".55" stop-color="#ffe14a"/><stop offset=".62" stop-color="#1550c0"/><stop offset="1" stop-color="#0d2a7a"/></linearGradient></defs>
  <rect x="1" y="-19" width="39" height="38" rx="1.5" fill="url(#pwf)" opacity=".95"/>
  <path d="M24,-18 C24,-4 16,6 12,18" stroke="#ffd25a" stroke-width="2" fill="none" opacity=".9"/>
  <rect x="-5" y="-29" width="10" height="6" rx="1.5" fill="#2a3644"/><rect x="-5" y="23" width="10" height="6" rx="1.5" fill="#2a3644"/>
</g>"""
dg=P(120,48)
dongle=f"""<path d="M{P(108,30)[0]:.1f},{P(108,30)[1]:.1f} C{P(112,42)[0]:.1f},{P(112,42)[1]:.1f} {P(118,40)[0]:.1f},{P(118,40)[1]:.1f} {dg[0]:.1f},{dg[1]:.1f}" stroke="#111" stroke-width="3" fill="none"/>
<g transform="translate({dg[0]:.1f},{dg[1]:.1f}) rotate(-20)"><rect x="-6" y="0" width="13" height="40" rx="3" fill="#1f6fd1"/><rect x="-3" y="-7" width="7" height="8" fill="#c7cdd4"/></g>"""

H=(640,362)  # head centre
arms=f"""
<!-- left arm reaches across to the front grip (the head hides part of it) -->
<path d="M565,470 C600,400 700,370 {P(45)[0]:.1f},{P(45)[1]+6:.1f}" stroke="#d9731c" stroke-width="40" stroke-linecap="round" fill="none"/>
<!-- right arm up to the rear grip -->
<path d="M720,470 C745,440 770,420 {P(0)[0]:.1f},{P(0)[1]+8:.1f}" stroke="#f08a2c" stroke-width="42" stroke-linecap="round" fill="none"/>"""
hands=f"""<circle cx="{P(45)[0]:.1f}" cy="{P(45)[1]:.1f}" r="17" fill="#e9b48e"/>
<circle cx="{P(0)[0]:.1f}" cy="{P(0)[1]:.1f}" r="18" fill="#f3c9a3"/>"""
body=f"""
<!-- hoodie, from the back -->
<path d="M500,640 C498,540 520,470 575,450 L705,450 C760,470 782,540 780,640 Z" fill="#f08a2c"/>
<path d="M640,460 L640,640" stroke="#dc7720" stroke-width="2" opacity=".6"/>
<!-- hood hanging on the back -->
<path d="M585,448 C585,500 610,525 640,525 C670,525 695,500 695,448 Z" fill="#d9731c"/>
<path d="M598,452 C600,492 618,510 640,510 C662,510 680,492 682,452" stroke="#c4651a" stroke-width="3" fill="none"/>
<!-- neck -->
<rect x="622" y="400" width="36" height="52" rx="14" fill="#e9b48e"/>"""
head=f"""
<!-- head from behind: hair, ears, headphones -->
<ellipse cx="{H[0]-56}" cy="{H[1]+8}" rx="9" ry="14" fill="#f0bf98"/>
<ellipse cx="{H[0]+56}" cy="{H[1]+8}" rx="9" ry="14" fill="#f0bf98"/>
<ellipse cx="{H[0]}" cy="{H[1]}" rx="58" ry="62" fill="#5a3a24"/>
<path d="M{H[0]-40},{H[1]+44} C{H[0]-20},{H[1]+58} {H[0]+20},{H[1]+58} {H[0]+40},{H[1]+44} L{H[0]+30},{H[1]+60} C{H[0]+10},{H[1]+68} {H[0]-10},{H[1]+68} {H[0]-30},{H[1]+60} Z" fill="#4a2f1c"/>
<path d="M{H[0]+6},{H[1]-30} a9,9 0 1 1 -9,-10 M{H[0]-34},{H[1]-6} l-6,22 M{H[0]-18},{H[1]-14} l-3,26 M{H[0]},{H[1]-12} l0,28 M{H[0]+18},{H[1]-14} l3,26 M{H[0]+34},{H[1]-6} l6,22" stroke="#7a5236" stroke-width="3" fill="none" stroke-linecap="round" opacity=".8"/>
<path d="M{H[0]-62},{H[1]+4} C{H[0]-66},{H[1]-82} {H[0]+66},{H[1]-82} {H[0]+62},{H[1]+4}" stroke="#1d2833" stroke-width="13" fill="none" stroke-linecap="round"/>
<path d="M{H[0]-62},{H[1]+4} C{H[0]-66},{H[1]-82} {H[0]+66},{H[1]-82} {H[0]+62},{H[1]+4}" stroke="#4fb3ff" stroke-width="3" fill="none" stroke-linecap="round" opacity=".8"/>
<ellipse cx="{H[0]-60}" cy="{H[1]+10}" rx="17" ry="28" fill="#1d2833"/>
<ellipse cx="{H[0]-62}" cy="{H[1]+10}" rx="9" ry="19" fill="#4fb3ff"/>
<ellipse cx="{H[0]+60}" cy="{H[1]+10}" rx="17" ry="28" fill="#1d2833"/>
<ellipse cx="{H[0]+62}" cy="{H[1]+10}" rx="9" ry="19" fill="#4fb3ff"/>"""
sat=f'''
<g transform="translate(1150,44) rotate(-35)">
  <rect x="-48" y="-10" width="34" height="20" fill="#2a64c9" stroke="#9cc4ff" stroke-width="1.5"/>
  <line x1="-41" y1="-10" x2="-41" y2="10" stroke="#9cc4ff" stroke-width=".8"/><line x1="-31" y1="-10" x2="-31" y2="10" stroke="#9cc4ff" stroke-width=".8"/><line x1="-22" y1="-10" x2="-22" y2="10" stroke="#9cc4ff" stroke-width=".8"/>
  <rect x="14" y="-10" width="34" height="20" fill="#2a64c9" stroke="#9cc4ff" stroke-width="1.5"/>
  <line x1="22" y1="-10" x2="22" y2="10" stroke="#9cc4ff" stroke-width=".8"/><line x1="31" y1="-10" x2="31" y2="10" stroke="#9cc4ff" stroke-width=".8"/><line x1="41" y1="-10" x2="41" y2="10" stroke="#9cc4ff" stroke-width=".8"/>
  <rect x="-14" y="-14" width="28" height="28" rx="3" fill="#d8dee6" stroke="#fff" stroke-width="1"/>
  <rect x="-8" y="-8" width="16" height="16" rx="2" fill="#ffb347"/>
  <line x1="0" y1="14" x2="0" y2="32" stroke="#fff" stroke-width="2"/>
</g>'''
import math as _m
def arc(cx,cy,r,a0,a1):
    p0=(cx+r*_m.cos(_m.radians(a0)),cy+r*_m.sin(_m.radians(a0))); p1=(cx+r*_m.cos(_m.radians(a1)),cy+r*_m.sin(_m.radians(a1)))
    return f'M{p0[0]:.1f},{p0[1]:.1f} A{r},{r} 0 0 1 {p1[0]:.1f},{p1[1]:.1f}'
waves="".join(f'<path d="{arc(1150,44,30+22*k,112,158)}" stroke="#ffd25a" stroke-width="4" stroke-linecap="round" fill="none" opacity="{1.0-0.22*k:.2f}"/>' for k in range(1,4))
_old="".join(f'<path d="M{1188-28*k*0.82-8:.0f},{60+28*k*0.57+6:.0f} a {22*k} {22*k} 0 0 0 {22*k*0.9:.0f} {-22*k*1.0:.0f}" stroke="#ffc83c" stroke-width="3" fill="none" opacity="{1-0.22*k:.2f}" transform="rotate(10 1188 52)"/>' for k in range(1,4))
stars="".join(f'<circle cx="{random.uniform(480,1280):.0f}" cy="{random.uniform(0,230):.0f}" r="{random.choice([0.8,1,1.2,1.6]):.1f}" fill="#fff" opacity="{random.uniform(.3,.9):.2f}"/>' for _ in range(60))

page=f'''<!doctype html><html><head><meta charset="utf-8"><style>
html,body{{margin:0;width:1280px;height:640px;overflow:hidden;background:#05080c}}
.wf{{position:absolute;inset:0;background:url(data:image/png;base64,{wf}) center/cover;filter:saturate(1.15) brightness(.95);
  -webkit-mask-image:linear-gradient(90deg,transparent 0%,rgba(0,0,0,.25) 22%,rgba(0,0,0,.9) 52%,#000 70%)}}
.sky{{position:absolute;inset:0;background:linear-gradient(180deg,rgba(5,8,12,.55) 0%,rgba(5,8,12,0) 40%),radial-gradient(ellipse at 52% 78%,rgba(5,8,12,.55),rgba(5,8,12,0) 55%)}}
.tle{{position:absolute;left:10px;top:-6px;width:470px;font:10.5px/10.9px "DejaVu Sans Mono",monospace;color:#4fb3ff;white-space:pre;opacity:.42;
  -webkit-mask-image:linear-gradient(90deg,#000 55%,transparent 100%)}}
.tle div:nth-child(3n){{opacity:.6}} .tle .hl{{color:#bfe3ff;text-shadow:0 0 6px #4fb3ff;opacity:1}}
.shade{{position:absolute;left:0;top:0;width:620px;height:640px;background:linear-gradient(90deg,rgba(5,8,12,.2),rgba(5,8,12,.55) 55%,rgba(5,8,12,0))}}
svg{{position:absolute;inset:0}}
.title{{position:absolute;left:48px;top:178px;font-family:Inter,sans-serif;color:#eef3f8}}
h1{{margin:0;font-size:66px;font-weight:800;letter-spacing:-1.5px;line-height:1;text-shadow:0 2px 18px rgba(0,0,0,.8)}}
h1 b{{color:#ff9a3c;text-shadow:0 0 18px rgba(255,90,0,.6)}}
.tag{{margin-top:14px;font-size:25px;font-weight:600;text-shadow:0 2px 10px #000}}
.sub{{margin-top:12px;font-size:16.5px;color:#a9b6c3;line-height:1.5;text-shadow:0 1px 6px #000}}
.url{{position:absolute;left:48px;bottom:30px;font:15px "DejaVu Sans Mono",monospace;color:#8fa0b0}}
</style></head><body>
<div class="wf"></div><div class="sky"></div>
<div class="tle">{tle_html}</div>
<div class="shade"></div>
<svg width="1280" height="640" viewBox="0 0 1280 640">
<defs><filter id="glow"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
{stars}
<path d="M520,250 Q860,-60 1280,30" stroke="#9cc4ff" stroke-width="1.6" stroke-dasharray="6 7" fill="none" opacity=".55"/>
<g filter="url(#glow)">{sat}</g>
{waves}
{arms}{handle}{boom}{boom_shade}{"".join(el)}{coax}{dongle}{phone}{hands}{body}{head}
</svg>
<div class="title"><h1>SatHunter<b>Web</b></h1>
<div class="tag">Hunt satellites in your browser.</div>
<div class="sub">ESP32-S3 over Web Serial · live TLEs · passes<br>Doppler marker · sky radar · GPS on phones</div></div>
<div class="url">z2labs.github.io/SatHunter-WEB-SDR</div>
</body></html>'''
open('banner.html','w').write(page)
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={'width':1280,'height':640})
    pg.goto('file://'+__import__('os').path.abspath('banner.html')); pg.wait_for_timeout(300)
    pg.screenshot(path='banner.png'); b.close()
print('done')
