
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { addressHash } from '../_shared/address.ts';
const DB_URL=Deno.env.get('SUPABASE_URL')!;
const SERVICE=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON=Deno.env.get('SUPABASE_ANON_KEY')!;
const db=createClient(DB_URL,SERVICE,{auth:{persistSession:false}});
const LOCATION='0mlZlQJf3q9VUxb5z0hM';
const CAMPAIGN='boggs-initial-14-completed-services-2026-10';
const PAGE_SIZE=100;
const PAGES_PER_CALL=3;
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,apikey,content-type','Access-Control-Allow-Methods':'POST,OPTIONS'};
const respond=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{...cors,'Content-Type':'application/json'}});
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response(null,{headers:cors});
 if(req.method!=='POST')return respond({error:'POST required'},405);
 const jwt=req.headers.get('Authorization')?.replace(/^Bearer\s+/i,'');
 if(!jwt)return respond({error:'Login required'},401);
 const auth=createClient(DB_URL,ANON,{auth:{persistSession:false}});
 const {data:{user},error:uErr}=await auth.auth.getUser(jwt);
 if(uErr||!user)return respond({error:'Invalid session'},401);
 const {data:admin,error:adminErr}=await db.from('app_users').select('is_super_admin').eq('id',user.id).maybeSingle();
 if(adminErr||!admin?.is_super_admin)return respond({error:'Super Admin access required'},403);
 let body:any={};try{body=await req.json();}catch{return respond({error:'Invalid request JSON'},400);}
 const action=String(body.action||'status');
 if(!['status','start','continue','resume','restart','diagnose'].includes(action))return respond({error:'Unknown action'},400);
 const {data:campaign,error:campaignErr}=await db.from('ripple_manual_campaign_drafts')
  .select('id,status').eq('location_id',LOCATION).eq('campaign_key',CAMPAIGN).maybeSingle();
 if(campaignErr||!campaign)return respond({error:'Draft campaign not found'},404);
 if(campaign.status!=='draft')return respond({error:'Campaign is no longer a draft'},409);
 const {data:existing,error:existingErr}=await db.from('ripple_matrix_contact_scan_runs')
   .select('*').eq('location_id',LOCATION).eq('campaign_id',campaign.id).maybeSingle();
 if(existingErr)return respond({error:'Cannot read scan progress'},500);
 let run=existing;
 if(action==='start'&&!run){
   const created=await db.from('ripple_matrix_contact_scan_runs')
      .insert({location_id:LOCATION,campaign_id:campaign.id}).select('*').single();
   if(created.error)return respond({error:created.error.message},409);
   run=created.data;
 }
 // Explicit restart is required for a completed scan with missing address extraction.
 // Delete only staging matches/checkpoints; never touch Matrix contacts or live mailings.
 if(action==='restart'&&run?.status==='complete'){
   if(Number(run.addressed_contacts||0)>0)return respond({error:'Completed scan already contains address data; restart blocked'},409);
   const cleanup=await db.from('ripple_matrix_scan_matches').delete().eq('scan_id',run.id);
   if(cleanup.error)return respond({error:'Could not reset provisional scan matches'},500);
   const reset=await db.from('ripple_matrix_contact_scan_runs').update({
     status:'running',page:1,scanned_contacts:0,addressed_contacts:0,
     matched_addresses:0,total_contacts:null,last_error:null,completed_at:null,
     updated_at:new Date().toISOString()
   }).eq('id',run.id).eq('status','complete').select('*').single();
   if(reset.error)return respond({error:'Could not restart scan: '+reset.error.message},409);
   run=reset.data;
 }
 if(action==='resume'&&run?.status==='failed'){
   const result=await db.from('ripple_matrix_contact_scan_runs').update({status:'running',last_error:null,updated_at:new Date().toISOString()}).eq('id',run.id).eq('status','failed').select('*').single();
   if(result.error)return respond({error:result.error.message},409);
   run=result.data;
 }
 const {data:matches,error:matchesErr}=run
   ? await db.from('ripple_matrix_scan_matches').select('addr_hash,contact_type,contact_status').eq('scan_id',run.id)
   : {data:[],error:null};
 if(matchesErr)return respond({error:'Cannot inspect scan matches'},500);
 async function status(){
   const {data:updated}=run
     ? await db.from('ripple_matrix_contact_scan_runs').select('*').eq('id',run.id).single()
     : {data:null};
   const {data:found}=run
     ? await db.from('ripple_matrix_scan_matches').select('addr_hash,contact_type,contact_status').eq('scan_id',run.id)
     : {data:[]};
   return {run:updated,matchedCandidates:found||[],noPostcardsSent:true,
    note:'Contact matches are flagged for review, not automatically classified as existing customers.'};
 }
 if(action!=='diagnose'&&(action==='status'||!run||run.status==='complete'||run.status==='failed'))return respond(await status());
 const {data:oauthRows,error:oErr}=await db.from('oauth_tokens')
   .select('provider,status,access_token_secret_id,expires_at,scopes,updated_at')
   .eq('location_id',LOCATION).order('updated_at',{ascending:false});
 if(oErr)return respond({error:'Cannot retrieve Matrix OAuth configuration'},500);
 const tokenRow=(oauthRows||[]).find((r:any)=>r.provider==='highlevel'&&r.status==='active'&&String(r.scopes||'').includes('contacts.readonly'));
 if(!tokenRow)return respond({error:'Matrix OAuth contact-read permission is missing; reconnect Ripple'},409);
 if(new Date(tokenRow.expires_at).getTime()<Date.now()+60000)
   return respond({error:'Matrix OAuth access token is near expiry; refresh/reconnect before scanning. Progress saved.'},409);
 const {data:access,error:accessErr}=await db.rpc('read_oauth_secret',{p_secret_id:tokenRow.access_token_secret_id});
 if(accessErr||!access)return respond({error:'Matrix OAuth token unavailable'},503);
 if(action==='diagnose'){
   const response=await fetch('https://services.leadconnectorhq.com/contacts/search',{
     method:'POST',headers:{'Authorization':'Bearer '+access,'Version':'v3','Content-Type':'application/json','Accept':'application/json'},
     body:JSON.stringify({locationId:LOCATION,page:1,pageLimit:5,filters:[]})
   });
   if(!response.ok)return respond({error:'Matrix search diagnostic HTTP '+response.status},502);
   const payload=await response.json();
   const contacts=Array.isArray(payload.contacts)?payload.contacts:[];
   const example=contacts[0]||{};
   // Keys and presence flags ONLY, never contact data.
   let detailKeys:string[]=[];
   let detailHasAddress=false;
   if(example.id){
     const d=await fetch('https://services.leadconnectorhq.com/contacts/'+encodeURIComponent(String(example.id)),{
       headers:{'Authorization':'Bearer '+access,'Version':'v3','Accept':'application/json'}
     });
     if(d.ok){
       const v=await d.json();const detail=v.contact||{};
       detailKeys=Object.keys(detail);
       detailHasAddress=!!((detail.address||detail.address1)&&detail.postalCode);
     }
   }
   return respond({
     searchKeys:Object.keys(payload),sampleContactKeys:Object.keys(example),
     sampleCount:contacts.length,searchHasAddress:!!((example.address||example.address1)&&example.postalCode),
     detailKeys,detailHasAddress,
     message:'Diagnostic lists field names only. No customer details are returned.'
   });
 }
 const {data:potential,error:potentialErr}=await db.from('ripple_manual_campaign_review_recipients')
   .select('addr_hash').eq('campaign_id',campaign.id);
 if(potentialErr)return respond({error:'Cannot load review recipient hashes'},500);
 const potentialHashes=new Set((potential||[]).map((r:any)=>r.addr_hash));
 let page=Number(run.page||1), scanned=Number(run.scanned_contacts||0),addressed=Number(run.addressed_contacts||0);
 let total=run.total_contacts==null?null:Number(run.total_contacts);
 let finished=false;
 let processed=0;
 try{
   for(let n=0;n<PAGES_PER_CALL;n++){
     const response=await fetch('https://services.leadconnectorhq.com/contacts/search',{
       method:'POST',
       headers:{'Authorization':'Bearer '+access,'Version':'v3','Content-Type':'application/json','Accept':'application/json'},
       body:JSON.stringify({locationId:LOCATION,page,pageLimit:PAGE_SIZE,filters:[]})
     });
     if(!response.ok){
       const message=(await response.text()).slice(0,250);
       throw Error('Matrix contact API '+response.status+' '+message);
     }
     const data=await response.json();
     if(!Array.isArray(data.contacts))throw Error('Unexpected Matrix pagination response (contacts array missing)');
     const contacts=data.contacts as any[];
     if(typeof data.total==='number'&&Number.isFinite(data.total))total=data.total;
     if(!contacts.length){finished=true;break;}
     const pending:any[]=[];
     for(const c of contacts){
       scanned++;
       // This does not read/update HighLevel contacts: only address fields are used.
       const street=String(c.address||c.address1||'').trim();
       const zip=String(c.postalCode||'').trim();
       if(!street||!zip)continue;
       addressed++;
       const hash=await addressHash(street,zip);
       if(hash&&potentialHashes.has(hash)){
         pending.push({
           scan_id:run.id,addr_hash:hash,contact_id:String(c.id||'').slice(0,100)||null,
           contact_type:String(c.type||'').slice(0,100)||null,
           contact_status:String(c.status||'').slice(0,100)||null
         });
       }
     }
     if(pending.length){
       const insert=await db.from('ripple_matrix_scan_matches').upsert(pending,{onConflict:'scan_id,addr_hash',ignoreDuplicates:true});
       if(insert.error)throw Error('Scan match save failed: '+insert.error.message);
     }
     page++;processed++;
     // Commit progress per successful page for resumability.
     if(contacts.length<PAGE_SIZE||(total!==null&&scanned>=total))finished=true;
     // A scan with zero usable addresses must not be labeled successful.
     if(finished&&addressed===0)throw Error('No street/ZIP values found; verify Matrix response field mapping before completing');
     const progress=await db.from('ripple_matrix_contact_scan_runs').update({
       page,scanned_contacts:scanned,addressed_contacts:addressed,total_contacts:total,
       status:finished?'complete':'running',completed_at:finished?new Date().toISOString():null,
       updated_at:new Date().toISOString(),last_error:null
     }).eq('id',run.id);
     if(progress.error)throw Error('Could not save page checkpoint: '+progress.error.message);
     if(finished)break;
   }
 }catch(e){
   // The checkpoint tracks only completed pages. No customer backfill flag is set.
   const err=String((e as Error).message).slice(0,350);
   await db.from('ripple_matrix_contact_scan_runs').update({status:'failed',last_error:err,updated_at:new Date().toISOString()}).eq('id',run.id);
   return respond({...(await status()),error:err,processedPages:processed},502);
 }
 return respond({...(await status()),processedPages:processed});
});
