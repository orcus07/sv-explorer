/* One-way copy of this reader's archive to the owner's PC. Never calls an LLM. */
(() => {
  'use strict';
  const LIBRARY = 'https://library.pensiev.me';
  const KEY = 'pensieve-reader-connection/v1';
  let connection = null, flushing = false, queued = Promise.resolve();
  const status = () => document.getElementById('pensieve-sync-status');
  const say = text => { if (status()) status().textContent = text; };
  try { connection = JSON.parse(localStorage.getItem(KEY)); } catch {}
  const dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('pensieve-reader-outbox', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('pending', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => say('서재 전송 대기열을 저장할 수 없습니다. 브라우저 저장 권한을 확인해주세요.'));
  async function operation(mode, action) {
    const db = await dbPromise;
    return new Promise((resolve,reject) => {
      const tx=db.transaction('pending',mode),req=action(tx.objectStore('pending'));
      tx.oncomplete=()=>resolve(req.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
    });
  }
  async function digest(record) {
    const raw=new TextEncoder().encode(JSON.stringify(record));
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',raw)),b=>b.toString(16).padStart(2,'0')).join('');
  }
  async function flush() {
    if(flushing||!connection)return;
    flushing=true;
    try {
      const all=await operation('readonly',s=>s.getAll());
      let count=0;
      for(const item of all.filter(x=>!x.sent)) {
        say('PC 서재에 저장하는 중…');
        const response=await fetch(connection.endpoint,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+connection.token},body:JSON.stringify({record:item.record}),signal:AbortSignal.timeout(20000),credentials:'omit',redirect:'error'});
        if(!response.ok){
          if(response.status===401){connection=null;localStorage.removeItem(KEY);throw Error('서재에서 리더를 다시 연결해주세요.');}
          const error=await response.json().catch(()=>({}));throw Error(error.error||'PC 서재 연결 대기');
        }
        await response.json();
        // An edit made while the request was in flight must remain pending.
        const db=await dbPromise;
        await new Promise((resolve,reject)=>{
          const tx=db.transaction('pending','readwrite'),s=tx.objectStore('pending'),r=s.get(item.id);
          r.onsuccess=()=>{if(r.result?.digest===item.digest)s.put({id:item.id,digest:item.digest,sent:true});};
          tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
        });count++;
      }
      say('PC 서재에 저장됨 · 리더에서 삭제해도 서재 기록은 유지됩니다.');
    } catch(e) {say((e.message||'PC 연결 대기')+' · 전송 대기 자료는 이 브라우저에 보관됩니다.');}
    finally {flushing=false;}
  }
  function queue(records) {
    // Snapshot before the reader's quota fallback removes full text.
    let snapshot;try{snapshot=JSON.parse(JSON.stringify(records));}catch{return;}
    queued=queued.then(async()=>{
      for(const record of snapshot){
        if(!record?.videoId)continue;
        const identity=record.videoId;
        const hash=await digest(record),old=await operation('readonly',s=>s.get(identity));
        if(old?.digest===hash)continue;
        await operation('readwrite',s=>s.put({id:identity,record,digest:hash,sent:false}));
      }
    }).then(flush).catch(()=>say('서재 전송 대기열 저장 실패 · 원래 리더 보관함은 유지됩니다.'));
  }
  window.PensieveSync={queue};
  addEventListener('message',event=>{
    if(event.origin!==LIBRARY||event.source!==window.opener||event.data?.type!=='pensieve-reader-connect')return;
    const {endpoint,token}=event.data;
    try{
      const u=new URL(endpoint);
      if(u.origin!=='https://laptop-6lmt6gii.tailcb76be.ts.net'||u.pathname!=='/reader-sync'||u.search||u.hash||typeof token!=='string'||token.length<32)return;
      connection={endpoint,token};localStorage.setItem(KEY,JSON.stringify(connection));
      event.source.postMessage({type:'pensieve-reader-connected'},LIBRARY);
      window.dispatchEvent(new Event('pensieve-archive-request'));
    }catch{say('연결 설정을 저장할 수 없습니다.');}
  });
  addEventListener('DOMContentLoaded',()=>{
    say(connection?'PC 서재 연결 확인 중…':'서재에서 이 리더를 한 번 연결하면 번역 결과가 자동 보관됩니다.');
    if(window.opener)window.opener.postMessage({type:'pensieve-reader-ready'},LIBRARY);
    if(connection)window.dispatchEvent(new Event('pensieve-archive-request'));
  });
  addEventListener('online',flush);
  setInterval(()=>{if(!document.hidden)flush();},30000);
})();
