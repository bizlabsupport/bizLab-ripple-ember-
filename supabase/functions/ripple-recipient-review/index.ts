
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { radiusSearch, getRecipients } from '../_shared/thanksio.ts';
import { addressHash, streetKey } from '../_shared/address.ts';
const URL=Deno.env.get('SUPABASE_URL')!;
const KEY=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON=Deno.env.get('SUPABASE_ANON_KEY')!;
const db=createClient(URL,KEY,{auth:{persistSession:false}});
const TARGET='0mlZlQJf3q9VUxb5z0hM';
const CAMPAIGN_KEY='boggs-initial-14-completed-services-2026-10';
const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,apikey,content-type','Access-Control-Allow-Methods':'POST,OPTIONS'};
const out=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,'Content-Type':'application/json'}});
const extract=(obj:any)=>obj && typeof obj==='object'?obj:{};
Deno.serve(async(req)=>{
 if(req.method==='OPTIONS')return new Response(null,{headers:CORS});
 if(req.method!=='POST')return out({error:'POST required'},405);
 const token=req.headers.get('Authorization')?.replace(/^Bearer\s+/i,'');
 if(!token)return out({error:'Login required'},401);
 const sb=createClient(URL,ANON,{auth:{persistSession:false}});
 const {data:{user},error:userErr}=await sb.auth.getUser(token);
 if(userErr||!user)return out({error:'Invalid session'},401);
 const {data:admin,error:adminErr}=await db.from('app_users').select('is_super_admin').eq('id',user.id).maybeSingle();
 if(adminErr||!admin?.is_super_admin)return out({error:'Super Admin only'},403);
 let request:any={};
 try{request=await req.json();}catch{return out({error:'Invalid JSON'},400)}
 const action=String(request.action||'status');
 const {data:campaign,error:cErr}=await db.from('ripple_manual_campaign_drafts')
 .select('id,location_id,status,send_cap_per_service,street_policy')
 .eq('location_id',TARGET).eq('campaign_key',CAMPAIGN_KEY).single();
 if(cErr||!campaign)return out({error:'Draft campaign not found'},404);
 if(campaign.status!=='draft'||campaign.send_cap_per_service!==10||campaign.street_policy!=='same_street_only')
 return out({error:'Draft rule mismatch; lookups blocked'},409);
 const {data:services,error:servicesErr}=await db.from('ripple_manual_campaign_draft_services')
 .select('service_number,service_address,postal_code,customer_name')
 .eq('campaign_id',campaign.id).order('service_number',{ascending:true});
 if(servicesErr||services?.length!==14)return out({error:'Expected 14 staged services'},409);
 const byStreet=new Map<string,any>();
 const sourceHashes=new Set<string>();
 for(const s of services||[]){
  const key=streetKey(s.service_address,s.postal_code);
  const hash=await addressHash(s.service_address,s.postal_code);
  if(!key||!hash)return out({error:'Invalid staged address',number:s.service_number},409);
  sourceHashes.add(hash);
  if(!byStreet.has(key))byStreet.set(key,s);
 }
 if(byStreet.size!==12)return out({error:'Unexpected count of unique streets; aborting paid searches',streets:byStreet.size},409);
 const query=await db.from('ripple_manual_campaign_review_lookups').select('*').eq('campaign_id',campaign.id).order('id');
 if(query.error)return out({error:query.error.message},500);
 let lookups=query.data||[];
 if(action==='status'){
  return out({draft:true,postcardsSent:false,streetCount:12,lookupRows:lookups,prices:{lookupCents:7,cardCents:104},maximumLookupSpendCents:840});
 }
 if(!['purchase','refresh','results'].includes(action))return out({error:'Unknown action'},400);
 if(action==='purchase'){
  // Reserve each street in the database BEFORE any paid API calls. Unique
  // campaign+street key prevents overlapping requests from purchasing twice.
  for(const [key,s] of byStreet){
   const {error}=await db.from('ripple_manual_campaign_review_lookups').upsert({
    campaign_id:campaign.id,location_id:TARGET,street_key:key,anchor_address:s.service_address,
    postal_code:s.postal_code,requested_records:10,status:'reserved'
   },{onConflict:'campaign_id,street_key',ignoreDuplicates:true});
   if(error)return out({error:'Unable to reserve lookup '+key},500);
  }
  lookups=(await db.from('ripple_manual_campaign_review_lookups').select('*').eq('campaign_id',campaign.id).order('id')).data||[];
  const errors:string[]=[];
  const {data:tokenRes,error:tokenErr}=await db.rpc('read_thanksio_token');
  if(tokenErr||!tokenRes)return out({error:'Thanks.io account token unavailable'},503);
  const tokenValue=String(tokenRes);
  let purchased=0;
  for(const row of lookups){
   if(row.status!=='reserved')continue;
   // Compare-and-set protects against accidental double-click races.
   const claim=await db.from('ripple_manual_campaign_review_lookups')
     .update({status:'initiating'}).eq('id',row.id).eq('status','reserved').select('id');
   if(claim.error||!claim.data?.length)continue;
   try{
    const response=await radiusSearch(tokenValue,{
     address:row.anchor_address,postalCode:row.postal_code,
     recordCount:10,includeCondos:false,includeSearchAddress:false,
     subAccount:3509
    });
    if(response.failure||!response.mailingListId)throw Error(response.message||'Thanks.io did not return a mailing list');
    const result=await db.from('ripple_manual_campaign_review_lookups').update({
      mailing_list_id:Number(response.mailingListId),status:'purchased',
    }).eq('id',row.id);
    if(result.error)throw Error('Lookup purchased but database save failed: '+result.error.message);
    purchased++;
   }catch(e){
    errors.push(row.street_key+': '+(e as Error).message);
    // Never automatically retry an uncertain paid request.
    await db.from('ripple_manual_campaign_review_lookups').update({
      status:'error_requires_review',error_message:String((e as Error).message).slice(0,500)
    }).eq('id',row.id);
   }
  }
  return out({ok:true,purchased,approvedMaxLookups:12,errors,message:'Paid lookups requested; no postcards sent. Wait briefly, then refresh recipient results.'});
 }
 if(action==='refresh'){
  const {data:tokenRes,error:tokenErr}=await db.rpc('read_thanksio_token');
  if(tokenErr||!tokenRes)return out({error:'Thanks.io token unavailable'},503);
  const reviewRows=lookups.filter((x:any)=>x.status==='purchased'&&x.mailing_list_id).slice(0,4);
  for(const row of reviewRows){
   try{
    const batch=await getRecipients(String(tokenRes),Number(row.mailing_list_id));
    if(!batch.length)continue; // Thanks.io builds search lists asynchronously.
    let same=0,eligible=0,excluded=0;
    const seen=new Set<string>();
    const candidates:any[]=[];
    for(const c of batch){
      const hash=await addressHash(c.address,c.postal_code||row.postal_code);
      if(!hash)continue;
      const isSame=streetKey(c.address,c.postal_code||row.postal_code)===row.street_key;
      if(!isSame||seen.has(hash))continue;
      same++;seen.add(hash);
      candidates.push({...c,addr_hash:hash,sourceCustomer:sourceHashes.has(hash)});
    }
    const verdict=new Map<string,string>();
    if(candidates.length){
      const {data:v,error:e}=await db.rpc('check_suppression',{
        p_location_id:TARGET,p_addr_hashes:candidates.map(c=>c.addr_hash)
      });
      if(e)throw Error('Suppression check failed: '+e.message);
      for(const item of v||[])verdict.set(item.addr_hash,item.reason);
    }
    for(const c of candidates){
      const reason=c.sourceCustomer?'existing_customer':(verdict.get(c.addr_hash)||'unknown');
      const status=reason==='ok'?'eligible':reason==='existing_customer'?'existing_customer':'suppressed';
      if(status==='eligible')eligible++;else excluded++;
      const {error}=await db.from('ripple_manual_campaign_review_recipients').upsert({
        campaign_id:campaign.id,lookup_id:row.id,addr_hash:c.addr_hash,
        address:c.address,city:c.city||null,province:c.province||null,
        postal_code:c.postal_code||row.postal_code,eligibility:status,reason
      },{onConflict:'campaign_id,addr_hash',ignoreDuplicates:true});
      if(error)throw Error('Review recipient save failed: '+error.message);
    }
    await db.from('ripple_manual_campaign_review_lookups').update({
      status:'populated',radius_candidate_count:batch.length,
      same_street_count:same,eligible_count:eligible,exclusion_count:excluded,
      completed_at:new Date().toISOString()
    }).eq('id',row.id);
   }catch(e){
    // Keep purchased status so fetch can be retried; never buy again.
    await db.from('ripple_manual_campaign_review_lookups').update({
      error_message:String((e as Error).message).slice(0,500)
    }).eq('id',row.id);
   }
  }
 }
 const {data:finalLookups,error:finalErr}=await db.from('ripple_manual_campaign_review_lookups')
 .select('id,street_key,anchor_address,status,mailing_list_id,radius_candidate_count,same_street_count,eligible_count,exclusion_count,error_message')
 .eq('campaign_id',campaign.id).order('id');
 if(finalErr)return out({error:finalErr.message},500);
 const {data:recipients,error:rErr}=await db.from('ripple_manual_campaign_review_recipients')
 .select('lookup_id,address,city,province,postal_code,eligibility,reason')
 .eq('campaign_id',campaign.id).order('id').limit(150);
 if(rErr)return out({error:rErr.message},500);
 const approvedCandidates=(recipients||[]).filter((r:any)=>r.eligibility==='eligible');
 const count=Math.min(120,approvedCandidates.length);
 return out({
  campaignStatus:'draft',postcardsSent:0,streetCount:12,
  requestedStreetLookups:(finalLookups||[]).length,
  purchasedStreetLookups:(finalLookups||[]).filter((r:any)=>!!r.mailing_list_id).length,
  completedStreetLookups:(finalLookups||[]).filter((r:any)=>r.status==='populated').length,
  estimatedLookupCostCents:(finalLookups||[]).filter((r:any)=>!!r.mailing_list_id).length*10*7,
  estimatedPostcardCostCents:count*104,
  eligibleCount:count,
  lookupRows:finalLookups,recipients
 });
});
