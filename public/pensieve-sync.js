/* Shared by both readers. Only library-started records enter the PC outbox. */
(() => {
  'use strict';
  const LIBRARY='https://library.pensiev.me', HOST='https://laptop-6lmt6gii.tailcb76be.ts.net';
  const KEY='pensieve-reader-launches/v1', ACTIVE='pensieve-active-launch/v1';
  let credentials={}, current=null, flushing=false, queued=Promise.resolve(), legacy=null;
  const say=text=>{const n=document.getElementById('pensieve-sync-status');if(n)n.textContent=text;};
  try{credentials=JSON.parse(localStorage.getItem(KEY)||'{}');legacy=JSON.parse(localStorage.getItem('pensieve-reader-connection/v1'));}catch{}
  function valid(c){try{const u=new URL(c.endpoint);return u.origin===HOST&&u.pathname==='/reader-launch/'+c.id&&!u.search&&!u.hash&&/^[a-f0-9]{32}$/.test(c.id)&&typeof c.token==='string'&&c.token.length>=32;}catch{return false;}}
  if(location.hash.startsWith('#pensieve-launch=')){
    const raw=location.hash.slice(17);history.replaceState(null,'',location.pathname+location.search);
    try{const c=JSON.parse(decodeURIComponent(raw));if(!valid(c))throw Error();credentials[c.id]=c;localStorage.setItem(KEY,JSON.stringify(credentials));sessionStorage.setItem(ACTIVE,c.id);}catch{addEventListener('DOMContentLoaded',()=>say('서재 연결 정보를 저장하지 못했습니다. 서재에서 다시 열어주세요.'));}
  }
  const dbPromise=new Promise((resolve,reject)=>{const r=indexedDB.open('pensieve-reader-outbox',1);r.onupgradeneeded=()=>r.result.createObjectStore('pending',{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  dbPromise.catch(()=>say('서재 전송 대기열을 열 수 없습니다. 브라우저 저장 권한을 확인해주세요.'));
  async function operation(mode,action){const db=await dbPromise;return new Promise((resolve,reject)=>{const tx=db.transaction('pending',mode),r=action(tx.objectStore('pending'));tx.oncomplete=()=>resolve(r.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
  async function request(id,path='',body){const c=credentials[id];if(!valid(c))throw Error('이 브라우저에 서재 작업 연결 정보가 없습니다. 서재에서 다시 열어주세요.');const r=await fetch(c.endpoint+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+c.token,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),credentials:'omit',redirect:'error',signal:AbortSignal.timeout(path==='/source'?60000:20000)});if(!r.ok){const e=await r.json().catch(()=>({}));throw Error(e.error||'PC 서재 연결 대기');}return path==='/source'?r.blob():r.json();}
  async function digest(record){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(record)))),x=>x.toString(16).padStart(2,'0')).join('');}
  async function flush(){
    if(flushing)return;flushing=true;
    try{
      const all=await operation('readonly',s=>s.getAll());
      for(const item of all.filter(x=>!x.sent)){
        try{
          say('PC 서재에 저장하는 중…');
          if(item.launch)await request(item.launch,'/result',{record:item.record});
          else if(legacy){ // Drain already-pending legacy work; never enqueue new standalone records.
            const u=new URL(legacy.endpoint);if(u.origin!==HOST||u.pathname!=='/reader-sync')continue;
            const r=await fetch(legacy.endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+legacy.token},body:JSON.stringify({record:item.record}),credentials:'omit',redirect:'error',signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('이전 전송 연결 대기');
          }else continue;
          const db=await dbPromise;
          await new Promise((resolve,reject)=>{const tx=db.transaction('pending','readwrite'),s=tx.objectStore('pending'),r=s.get(item.id);r.onsuccess=()=>{if(r.result?.digest===item.digest)s.put({id:item.id,digest:item.digest,sent:true});};tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
          say('원래 서재 콘텐츠에 저장됐어요. 추가 번역·챕터 해설도 같은 곳에 반영됩니다.');
        }catch(e){say((e.message||'PC 연결 대기')+' · 결과는 이 브라우저에 보관되며 연결이 돌아오면 다시 전송합니다.');}
      }
    }finally{flushing=false;}
  }
  function queue(records){
    let snapshot;try{snapshot=JSON.parse(JSON.stringify(records.filter(r=>r?._pensieveLaunch&&valid(credentials[r._pensieveLaunch]))));}catch{return;}
    queued=queued.then(async()=>{
      for(const record of snapshot){
        const launch=record?._pensieveLaunch, identity=record?.videoId||record?.id;
        if(!identity||!launch||!valid(credentials[launch]))continue;
        const id=launch+':'+identity,hash=await digest(record),old=await operation('readonly',s=>s.get(id));
        if(old?.digest!==hash)await operation('readwrite',s=>s.put({id,launch,record,digest:hash,sent:false}));
      }
    }).then(flush).catch(()=>say('전송 대기열 저장 실패 · 리더 보관함의 원본은 유지됩니다.'));
    return queued;
  }
  async function boot(handler,showSaved){
    const id=sessionStorage.getItem(ACTIVE);if(!id||!valid(credentials[id])){say('서재에서 시작한 증류만 PC 서재에 자동 저장됩니다.');return;}
    try{
      current=await request(id);
      const panel=document.createElement('section');panel.className='pensieve-launch-panel';panel.style.cssText='padding:16px;border:1px solid #ddd;margin:16px 0;border-radius:8px';
      const heading=document.createElement('strong');heading.textContent='서재에서 가져온 자료 · '+current.title;
      const details=document.createElement('details'),summary=document.createElement('summary'),text=document.createElement('p');summary.textContent='이번 증류에 적용할 서재 관점';text.textContent=current.perspective;text.style.whiteSpace='pre-wrap';details.append(summary,text);
      const retry=document.createElement('button');retry.textContent=current.status==='ready'?'증류 시작':'이 관점으로 다시 증류';
      const back=document.createElement('a');back.href=LIBRARY+'/#item='+encodeURIComponent(current.item_id);back.textContent='서재에서 보기 ↗';back.style.marginLeft='16px';
      let running=false;
      const execute=async()=>{if(running)return;running=true;retry.disabled=true;try{await handler(current);}catch(e){say(e.message);}finally{running=false;retry.disabled=false;retry.textContent='이 관점으로 다시 증류';}};
      retry.onclick=execute;panel.append(heading,details,retry,back);const anchor=document.getElementById('pensieve-sync-status');if(anchor)anchor.after(panel);
      if(current.status==='ready'){
        const claim=await request(id,'/start',{});if(claim.started)await execute();
      }else if(showSaved && await showSaved(current))say('보관된 증류 결과를 열었어요. 새 모델 호출 없이 이어서 읽습니다.');
      else say('이전에 연 서재 작업입니다. 자동으로 다시 증류하지 않습니다.');
    }catch(e){say(e.message+' · 서재에서 다시 열어주세요.');}
  }
  window.PensieveSync={queue,boot,request,matching:url=>current&&current.url===url?current:null};
  addEventListener('online',()=>flush().catch(()=>{}));
  addEventListener('DOMContentLoaded',()=>{try{queue(JSON.parse(localStorage.getItem('reader-archive/v1')||'[]'));}catch{}flush().catch(()=>{});});
  setInterval(()=>{if(!document.hidden)flush().catch(()=>{});},30000);
})();
