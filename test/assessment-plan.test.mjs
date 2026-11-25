import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {resolveChromiumExecutable} from '../src/browser/session.mjs';
import {PrognocisBrowser} from '../src/integrations/prognocis-browser.mjs';
import {artifact} from '../test-support/artifact.mjs';

for (const failPlan of [false, true]) test(`shared Assessment Notes page: keyup enables save, preserves both fields; failed Plan save=${failPlan}`, async () => {
 const browser=await chromium.launch({headless:true,executablePath:await resolveChromiumExecutable({projectRoot:process.cwd()})});
 try {
  const page=await browser.newPage();const saved={assessment:'',plan:'',procedures:'Existing procedure'};let saves=0;
  await page.route('https://ehr.example.test/**',async route=>{
   const req=route.request();const path=new URL(req.url()).pathname;
   if(path==='/Assessment.action2'){
    if(req.method()==='POST'){
     const data=req.postDataJSON();saves++;
     if(failPlan&&data.plan)return route.fulfill({status:500,body:'Save failed'});
     Object.assign(saved,data);
    } else await new Promise(r=>setTimeout(r,100));
    return route.fulfill({contentType:'text/html',body:`<button id="tab_3" onclick="document.querySelector('#notes').hidden=false">Notes</button>
      <div id="notes" hidden><textarea id="assessment" onkeyup="document.querySelector('#save').disabled=false">${saved.assessment}</textarea>
      <textarea id="plan" onkeyup="document.querySelector('#save').disabled=false">${saved.plan}</textarea><textarea id="procedures">${saved.procedures}</textarea></div>
      <button id="save" disabled onclick="save()">Save</button><script>async function save(){await fetch('/Assessment.action2',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assessment:document.querySelector('#assessment').value,plan:document.querySelector('#plan').value,procedures:document.querySelector('#procedures').value})});}</script>`});
   }
   await route.fulfill({contentType:'text/html',body:`<button id="menu_AS" onclick="document.querySelector('iframe').src='/Assessment.action2?visit='+Date.now()">Assessment</button><iframe></iframe>`});
  });
  await page.goto('https://ehr.example.test/encounter');
  const selectors={};for(const section of ['assessment','plan'])Object.assign(selectors,{[section+'Menu']:'#menu_AS',[section+'NotesTab']:'#tab_3',[section+'Field']:'#'+section,[section+'SaveButton']:'#save'});
  const destination=new PrognocisBrowser(page,{selectors,sectionUrlPatterns:{assessment:'/Assessment\\.action2',plan:'/Assessment\\.action2'},sectionSaveUrlPattern:'/Assessment\\.action2',saveTimeoutMs:2000,sectionLoadTimeoutMs:2000},{});
  const value=artifact();const state={sections:Object.fromEntries(Object.keys(value.sections).map(s=>[s,{matches:!['assessment','plan'].includes(s)}]))};
  if(failPlan){await assert.rejects(destination.writeMissingSections(value,state),/HTTP 500/);assert.equal(saved.assessment,value.sections.assessment);assert.equal(saved.plan,'');}
  else {await destination.writeMissingSections(value,state);for(const section of ['assessment','plan'])assert.equal(await destination.readSection(section),value.sections[section]);}
  assert.equal(saved.procedures,'Existing procedure');assert.equal(saves,2);
 } finally {await browser.close();}
});
