import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const DOCS=process.env.DOCS_EMBED_DIR, SHEETS=process.env.SHEETS_EMBED_DIR, FONTS=process.env.DOCS_FONTS_DIR;
if(!DOCS||!SHEETS||!FONTS){console.error('set DOCS_EMBED_DIR, SHEETS_EMBED_DIR, DOCS_FONTS_DIR (see README)');process.exit(1);}
const STORE=path.resolve('store'); const log=[];
const ct={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.wasm':'application/wasm','.json':'application/json'};
const ver=new Map();
http.createServer((req,res)=>{
  const u=new URL(req.url,'http://x'); const p=u.pathname;
  const send=(code,body,type='text/plain')=>{res.writeHead(code,{'content-type':type});res.end(body)};
  if(p.startsWith('/xlsx/')) return send(200,fs.readFileSync(path.join('xlsx',path.basename(p))),'text/javascript');
  if(p==='/host.html') return send(200,fs.readFileSync('host.html'),'text/html');
  if(p==='/log') return send(200,JSON.stringify(log),'application/json');
  let m;
  if((m=p.match(/^\/api\/files\/([a-z0-9]+)$/))){
    if(!(req.headers.cookie||'').includes('sid=valid')){log.push('401 '+req.method+' '+p);return send(401,'unauthenticated');}
    const id=m[1]; const ext=id.startsWith('sheet')?'.xlsx':'.docx'; const f=path.join(STORE,id+ext);
    if(req.method==='GET'){ if(!fs.existsSync(f)) return send(404,'nf'); const b=fs.readFileSync(f); res.writeHead(200,{'content-type':'application/octet-stream',etag:'"'+(ver.get(id)||1)+'"'}); log.push('GET '+id+' '+b.length); return res.end(b);}
    if(req.method==='PUT'){ const ch=[]; req.on('data',c=>ch.push(c)); req.on('end',()=>{const b=Buffer.concat(ch); const cur=ver.get(id)||1; const im=req.headers['if-match']; if(im&&im!=='"'+cur+'"'){log.push('409 PUT '+id);return send(409,'conflict');} fs.writeFileSync(f+'.tmp',b); fs.renameSync(f+'.tmp',f); ver.set(id,cur+1); log.push('PUT '+id+' '+b.length+' -> v'+(cur+1)); res.writeHead(200,{etag:'"'+(cur+1)+'"'}); res.end('ok');}); return;}
  }
  for(const [prefix,dir] of [['/embed/docs/',DOCS],['/embed/sheets/',SHEETS],['/embed/fonts/',FONTS]]){
    if(p.startsWith(prefix)){ let rel=p.slice(prefix.length)||'embed.html'; let f=path.join(dir,path.normalize(rel).replace(/^(\.\.[/\\])+/,''));
      if(!fs.existsSync(f)&&f.endsWith('.js')&&fs.existsSync(f.slice(0,-3)+'.mjs')) f=f.slice(0,-3)+'.mjs'; // docs 1.4.2 packaging mismatch
      if(!fs.existsSync(f)){log.push('404 '+p);return send(404,'nf');}
      return send(200,fs.readFileSync(f),ct[path.extname(f)]||'application/octet-stream'); }
  }
  log.push('404 '+p); send(404,'nf');
}).listen(18999,()=>console.log('poc listening'));
