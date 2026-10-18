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
:root{--bg:#0e1512;--panel:#16201b;--me:#2f9e5b;--bot:#22302a;--text:#e9f2ec;--muted:#93a89c;--accent:#ffb347}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% 0%,#1d3a2a,var(--bg) 60%);color:var(--text);
font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;height:100dvh;display:flex;justify-content:center}
.app{width:100%;max-width:520px;display:flex;flex-direction:column;height:100dvh}
header{padding:18px 20px 12px;border-bottom:1px solid #ffffff14}
h1{margin:0;font-size:20px;letter-spacing:.3px}h1 span{color:var(--accent)}
header p{margin:4px 0 0;color:var(--muted);font-size:13px}
#log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px}
.b{max-width:82%;padding:10px 14px;border-radius:18px;white-space:pre-wrap;word-wrap:break-word}
.bot{background:var(--bot);align-self:flex-start;border-bottom-left-radius:6px}
.me{background:var(--me);align-self:flex-end;border-bottom-right-radius:6px}
.b img{max-width:100%;border-radius:12px;display:block}
.typing{color:var(--muted);font-size:13px;align-self:flex-start;padding:0 6px}
form{display:flex;gap:8px;padding:12px;border-top:1px solid #ffffff14;background:var(--panel)}
input[type=text]{flex:1;background:#0b110e;border:1px solid #ffffff22;color:var(--text);border-radius:22px;padding:11px 16px;font-size:16px}
button,label.cam{background:var(--me);color:#fff;border:0;border-radius:22px;padding:0 16px;font-size:16px;cursor:pointer;display:flex;align-items:center}
label.cam{background:#2b3a33}input[type=file]{display:none}
</style></head><body><div class="app">
<header><h1>Cool<span>Block</span> 🌳🛰️</h1><p>Your block's summer heat, measured from space. Same agent as our iMessage number.</p></header>
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
