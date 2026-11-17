import {createClient} from 'jsr:@supabase/supabase-js@2';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, apikey, x-client-info, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json','Cache-Control':'no-store'}});
Deno.serve(async(req:Request)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
 if(req.method!=='POST')return json({error:'POST only'},405);
 const url=Deno.env.get('SUPABASE_URL')!,key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
 const bearer=req.headers.get('Authorization')||'';
 if(!bearer.startsWith('Bearer '))return json({error:'Please sign in.'},401);
 const caller=createClient(url,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:bearer}}});
 const {data:user,error:authError}=await caller.auth.getUser();
 if(authError||!user.user)return json({error:'Invalid session.'},401);
 const db=createClient(url,key);
 const {data:me}=await db.from('app_users').select('is_super_admin').eq('id',user.user.id).maybeSingle();
 if(!me?.is_super_admin)return json({error:'Super Admin access required.'},403);
 let b:any;try{b=await req.json()}catch{return json({error:'Invalid request.'},400)}
 try{
  if(b.action==='list'){
   const [n,l]=await Promise.all([
    db.from('business_niches').select('*').order('name'),
    db.from('config').select('location_id,client_name,business_niche_id,landing_url,booking_page_url,theme,prize_weights').not('location_id','is',null).neq('location_id','').not('location_id','like','company:%').order('client_name')
   ]);
   if(n.error||l.error)throw n.error||l.error;
   return json({ok:true,niches:n.data,locations:l.data});
  }
  if(b.action==='saveNiche'){
   const name=String(b.name||'').trim();const landing=String(b.landing_url||'').trim();const booking=String(b.booking_page_url||'').trim();
   const valid=(v:string)=>{try{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password&&!u.hash&&!u.search}catch{return false}};
   if(!name||name.length>100||!valid(landing)||!valid(booking))return json({error:'Enter a name and full HTTPS page URLs without query strings or fragments.'},400);
   if(landing===booking)return json({error:'Scratch-card and booking URLs must be different.'},400);
   const active=b.active!==false;
   if(b.id&&!active){const {count,error}=await db.from('config').select('location_id',{count:'exact',head:true}).eq('business_niche_id',b.id);if(error)throw error;if(count)return json({error:'Reassign linked locations before deactivating this niche.'},409)}
   const values={name,landing_url:landing,booking_page_url:booking,active,updated_at:new Date().toISOString()};
   let q=b.id?db.from('business_niches').update(values).eq('id',b.id).eq('updated_at',b.expected_updated_at||''):db.from('business_niches').insert(values);
   const {data,error}=await q.select('id').maybeSingle();if(error){if(error.code==='23505')return json({error:'A niche with this name already exists.'},409);throw error}
   if(!data)return json({error:'This niche changed. Refresh and try again.'},409);
   return json({ok:true});
  }
  if(b.action==='assign'){
   const location=String(b.location_id||'');const niche=b.niche_id||null;
   if(niche){const {data:n,error}=await db.from('business_niches').select('id').eq('id',niche).eq('active',true).maybeSingle();if(error)throw error;if(!n)return json({error:'Choose an active business niche.'},400)}
   const {data,error}=await db.from('config').update({business_niche_id:niche}).eq('location_id',location).select('location_id').maybeSingle();
   if(error)throw error;if(!data)return json({error:'Location not found.'},404);
   return json({ok:true});
  }
  return json({error:'Unknown action.'},400);
 }catch(error){console.error('business-niches',error);return json({error:'Could not save or load business niche settings. Please refresh and try again.'},500)}
});