import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {PrognocisBrowser} from '../src/integrations/prognocis-browser.mjs';
import {resolveChromiumExecutable} from '../src/browser/session.mjs';
const patient={firstName:'Sample',lastName:'Patient',dob:'1980-01-02'};
const row=(id)=>`<tr class="result" onclick="top.selected='${id}';top.document.querySelector('#identity').textContent=this.innerText"><td>Patient, Sample 01/02/1980</td></tr>`;
async function fixture({search=true,finalRows=1,delay=400,renderDelay=0,wrongFilters=false,iframeResults=false,responseStatus=200}={}){
 const browser=await chromium.launch({headless:true,executablePath:await resolveChromiumExecutable({projectRoot:process.cwd()})});
 const page=await browser.newPage();
 await page.route('**/*',async route=>{
   const u=new URL(route.request().url());
   if(u.pathname==='/ajaxLoadSearchData.action2'){
     await new Promise(r=>setTimeout(r,delay));
     await route.fulfill({status:responseStatus,contentType:'application/json',body:JSON.stringify({html:Array.from({length:finalRows},(_,i)=>row(`fresh-${i}`)).join('')})});return;
   }
   if(u.pathname==='/initial-results'){await route.fulfill({contentType:'text/html',body:`<table><tbody id="rows">${row('stale-0')}${row('stale-1')}</tbody></table>`});return;}
   await route.fulfill({contentType:'text/html',body:`<input id="first"><input id="last"><div id="identity"></div>
     ${iframeResults?'<iframe id="resultsFrame" src="/initial-results"></iframe>':`<table><tbody id="rows">${row('stale-0')}${row('stale-1')}</tbody></table>`}
     <script>window.selected=null;
     document.querySelector('#first').onkeyup=()=>{
       if(!${search})return;
       setTimeout(async()=>{
         const body=new URLSearchParams({first:${wrongFilters?'"Other"':"document.querySelector('#first').value"},last:document.querySelector('#last').value});
         const result=await fetch('/ajaxLoadSearchData.action2',{method:'POST',body}).then(r=>r.json());
         setTimeout(()=>{const target=${iframeResults?"document.querySelector('#resultsFrame').contentDocument":'document'};target.querySelector('#rows').innerHTML=result.html;},${renderDelay});
       },100);
     };</script>`});
 });
 await page.goto('https://ehr.example.test/scrCalcSearch.jsp');
 const destination=new PrognocisBrowser(page,{patientSearchTimeoutMs:1500,selectors:{patientFirstName:'#first',patientLastName:'#last',patientResultRows:'.result',patientSearchButton:'',activePatientIdentity:'#identity'}},{});
 destination.openPatientSearch=async()=>page;
 return {browser,page,destination};
}
for(const iframeResults of [false,true])test(`waits for filtered AJAX and delayed DOM update (iframe=${iframeResults})`,async()=>{
 const f=await fixture({iframeResults,renderDelay:500});try{const start=Date.now();await f.destination.selectPatient(patient);assert.ok(Date.now()-start>=900);assert.equal(await f.page.evaluate(()=>window.selected),'fresh-0');}finally{await f.browser.close();}
});
for(const [label,options] of [['missing response',{search:false}],['wrong name filters',{wrongFilters:true}],['ambiguous final results',{finalRows:2}],['empty final results',{finalRows:0}],['failed search response',{responseStatus:500}]]){
 test(`does not select a patient with ${label}`,async()=>{const f=await fixture(options);try{await assert.rejects(f.destination.selectPatient(patient));assert.equal(await f.page.evaluate(()=>window.selected),null);}finally{await f.browser.close();}});
}
