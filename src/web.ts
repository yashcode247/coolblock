// Web chat fallback: same agent, works without Photon. Also a backup for the live demo.
import { createServer } from "node:http";
import type { CoolBlock } from "./agent.js";

const MAX_BODY = 20 * 1024 * 1024;

export function runWeb(bot: CoolBlock, port: number) {
  createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/" || req.url?.startsWith("/?"))) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(PAGE);
      }
      if (req.method === "POST" && req.url === "/api/msg") {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > MAX_BODY) { res.writeHead(413); return res.end(); }
          chunks.push(c as Buffer);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const replies = await bot.handle(`web:${body.user ?? "anon"}`, {
          text: body.text,
          image: body.imageB64 ? { data: Buffer.from(body.imageB64, "base64"), mimeType: body.mimeType } : undefined,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(replies.map((r) =>
          r.type === "text" ? r : { type: "image", src: `data:image/jpeg;base64,${r.jpeg.toString("base64")}` })));
      }
      res.writeHead(404).end();
    } catch (e) {
      console.error("[web]", e);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify([{ type: "text", text: "Something went wrong, try again." }]));
    }
  }).listen(port, () => console.log(`💬 Web chat on http://localhost:${port}`));
}

const PAGE = /* html */ `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>CoolBlock</title>
<style>
:root{--me:#2f9e5b;--bot:#ffffffe6;--text:#13261b;--muted:#4d6656;--accent:#ff9a3c}
*{box-sizing:border-box}
body{margin:0;color:var(--text);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;height:100dvh;display:flex;justify-content:center;
background:linear-gradient(180deg,#070b24 0%,#121a45 40%,#1d2f5c 70%,#24476a 100%);overflow:hidden}
.sun{position:fixed;top:7vh;right:10vw;width:170px;height:170px;border-radius:50%;z-index:0;
background:radial-gradient(circle at 30% 35%,#c9c4b0 0 9%,transparent 10%),radial-gradient(circle at 62% 58%,#cfcab6 0 13%,transparent 14%),
radial-gradient(circle at 55% 25%,#d6d1bd 0 6%,transparent 7%),radial-gradient(circle at 35% 70%,#d3cebb 0 7%,transparent 8%),
radial-gradient(circle at 40% 40%,#fffbea,#ece6cf 70%,#d9d2b8);box-shadow:0 0 60px 20px #fff6d455,0 0 160px 60px #9fb7ff33}
.stars{position:fixed;inset:0;z-index:0;pointer-events:none;
background-image:radial-gradient(1.5px 1.5px at 10% 12%,#fff,transparent),radial-gradient(1px 1px at 22% 30%,#fff,transparent),
radial-gradient(1.5px 1.5px at 35% 8%,#fff,transparent),radial-gradient(1px 1px at 48% 22%,#fff,transparent),radial-gradient(2px 2px at 60% 14%,#fff,transparent),
radial-gradient(1px 1px at 70% 35%,#fff,transparent),radial-gradient(1.5px 1.5px at 92% 40%,#fff,transparent),radial-gradient(1px 1px at 5% 42%,#fff,transparent),
radial-gradient(1.5px 1.5px at 28% 48%,#fff,transparent),radial-gradient(1px 1px at 55% 45%,#fff,transparent),radial-gradient(1px 1px at 82% 6%,#fff,transparent),
radial-gradient(1.5px 1.5px at 15% 60%,#fff,transparent),radial-gradient(1px 1px at 96% 18%,#fff,transparent);animation:twinkle 4s ease-in-out infinite alternate}
@keyframes twinkle{from{opacity:.55}to{opacity:1}}
.forest{position:fixed;left:0;right:0;bottom:0;width:100%;height:58vh;z-index:0;pointer-events:none}
.leaf{position:fixed;top:-40px;font-size:22px;z-index:0;animation:fall linear infinite;opacity:.85}
@keyframes fall{to{transform:translate(80px,110vh) rotate(540deg)}}
@keyframes sway{0%,100%{transform:rotate(-1.2deg)}50%{transform:rotate(1.2deg)}}
.forest .sway{transform-origin:50% 100%;animation:sway 6s ease-in-out infinite}
.app{position:relative;z-index:1;width:100%;max-width:540px;display:flex;flex-direction:column;height:calc(100dvh - 32px);margin:16px;
background:#0b14331a;backdrop-filter:blur(1.5px);-webkit-backdrop-filter:blur(1.5px);border:1px solid #ffffff40;border-radius:28px;overflow:hidden;
box-shadow:0 20px 60px #00000080}
header{padding:20px 22px 14px;background:linear-gradient(135deg,#1f6b43b3,#2f9e5b99);color:#fff}
h1{margin:0;font-size:24px;letter-spacing:.3px}h1 span{color:#ffd27a}
header p{margin:4px 0 0;color:#e2f5e9;font-size:13px}
#log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px}
.b{max-width:82%;padding:10px 14px;border-radius:18px;white-space:pre-wrap;word-wrap:break-word;box-shadow:0 2px 8px #1b4d3220}
.bot{background:var(--bot);align-self:flex-start;border-bottom-left-radius:6px}
.me{background:var(--me);color:#fff;align-self:flex-end;border-bottom-right-radius:6px}
.b img{max-width:100%;border-radius:12px;display:block}
.typing{color:#c9d6f0;font-size:13px;align-self:flex-start;padding:0 6px}
form{display:flex;gap:8px;padding:12px;background:#ffffff1f;border-top:1px solid #ffffff40}
input[type=text]{flex:1;background:#fff;border:1px solid #2f9e5b55;color:var(--text);border-radius:22px;padding:11px 16px;font-size:16px;outline:none}
input[type=text]:focus{border-color:var(--me);box-shadow:0 0 0 3px #2f9e5b33}
button,label.cam{background:var(--me);color:#fff;border:0;border-radius:22px;padding:0 18px;font-size:16px;font-weight:600;cursor:pointer;display:flex;align-items:center}
button:hover{background:#268a4e}label.cam{background:#e3f3e9;color:#1f6b43}input[type=file]{display:none}
</style></head><body>
<div class="stars"></div><div class="sun"></div>
<svg class="forest" viewBox="0 0 1440 520" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
<defs>
<g id="oak"><rect x="-7" y="-70" width="14" height="70" rx="4" fill="#2a2320"/><circle cx="0" cy="-110" r="52"/><circle cx="-38" cy="-80" r="38"/><circle cx="38" cy="-82" r="40"/><circle cx="0" cy="-150" r="34"/></g>
<g id="pine"><rect x="-6" y="-40" width="12" height="40" fill="#2a2320"/><polygon points="0,-210 -55,-90 55,-90"/><polygon points="0,-170 -68,-40 68,-40"/></g>
</defs>
<g fill="#2f5a63" opacity=".85">
<use href="#pine" x="60" y="380" transform="scale(1)"/><use href="#oak" x="200" y="370"/><use href="#pine" x="330" y="385"/><use href="#oak" x="480" y="375"/>
<use href="#pine" x="620" y="380"/><use href="#oak" x="780" y="372"/><use href="#pine" x="930" y="384"/><use href="#oak" x="1080" y="370"/>
<use href="#pine" x="1220" y="382"/><use href="#oak" x="1370" y="374"/>
</g>
<rect y="380" width="1440" height="140" fill="#264d55"/>
<g fill="#1c3f44">
<g class="sway"><use href="#oak" x="110" y="470" transform="translate(110 470) scale(1.35) translate(-110 -470)"/></g>
<use href="#pine" x="300" y="480" transform="translate(300 480) scale(1.25) translate(-300 -480)"/>
<g class="sway" style="animation-delay:-2s"><use href="#oak" x="560" y="475" transform="translate(560 475) scale(1.2) translate(-560 -475)"/></g>
<use href="#pine" x="900" y="485" transform="translate(900 485) scale(1.3) translate(-900 -485)"/>
<g class="sway" style="animation-delay:-4s"><use href="#oak" x="1130" y="470" transform="translate(1130 470) scale(1.4) translate(-1130 -470)"/></g>
<use href="#pine" x="1350" y="482" transform="translate(1350 482) scale(1.2) translate(-1350 -482)"/>
</g>
<rect y="470" width="1440" height="50" fill="#14302f"/>
<g fill="#0d2322">
<use href="#oak" x="20" y="535" transform="translate(20 535) scale(1.7) translate(-20 -535)"/>
<use href="#oak" x="1420" y="535" transform="translate(1420 535) scale(1.8) translate(-1420 -535)"/>
</g>
</svg>
<span class="leaf" style="left:8%;animation-duration:14s">🍃</span><span class="leaf" style="left:30%;animation-duration:19s;animation-delay:-6s">🍂</span>
<span class="leaf" style="left:62%;animation-duration:16s;animation-delay:-11s">🍃</span><span class="leaf" style="left:85%;animation-duration:21s;animation-delay:-3s">🌿</span>
<div class="app">
<header><h1>Cool<span>Block</span> 🌳🛰️</h1><p>Your block's heat, seen from space. Your street, reimagined with trees.</p></header>
<div id="log"></div>
<form id="f"><label class="cam" title="Send a street photo">📷<input id="file" type="file" accept="image/*"></label>
<input id="t" type="text" placeholder="Type an address, e.g. Nubian Square" autocomplete="off"><button>Send</button></form>
</div><script>
const log=document.getElementById('log'),t=document.getElementById('t'),file=document.getElementById('file');
let user;try{user=localStorage.getItem('cb_user')}catch(e){}
if(!user){user=Math.random().toString(36).slice(2);try{localStorage.setItem('cb_user',user)}catch(e){}}
function add(cls,content){const d=document.createElement('div');d.className='b '+cls;
 if(typeof content==='string')d.textContent=content;else d.appendChild(content);log.appendChild(d);log.scrollTop=log.scrollHeight}
async function send(payload){const ty=document.createElement('div');ty.className='typing';ty.textContent='CoolBlock is typing…';log.appendChild(ty);log.scrollTop=log.scrollHeight;
 try{const r=await fetch('/api/msg',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user,...payload})});
 const replies=await r.json();ty.remove();for(const x of replies){if(x.type==='text')add('bot',x.text);else{const i=new Image();i.src=x.src;add('bot',i)}}}
 catch(e){ty.remove();add('bot','Connection problem, try again.')}}
document.getElementById('f').onsubmit=e=>{e.preventDefault();const v=t.value.trim();if(!v)return;add('me',v);t.value='';send({text:v})};
file.onchange=()=>{const f=file.files[0];if(!f)return;const rd=new FileReader();rd.onload=()=>{const url=rd.result;
 const i=new Image();i.src=url;add('me',i);send({imageB64:url.split(',')[1],mimeType:f.type})};rd.readAsDataURL(f);file.value=''};
send({text:'hi'});
</script></body></html>`;
