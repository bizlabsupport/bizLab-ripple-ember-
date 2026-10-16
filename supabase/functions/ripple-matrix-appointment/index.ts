import {createClient} from "jsr:@supabase/supabase-js@2";
import {addressHash} from "../_shared/address.ts";
const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
const secret=Deno.env.get("RIPPLE_CALLER_SECRET");
const respond=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
const value=(x:unknown)=>String(x??"").trim();
function eventName(v:unknown){
 const k=value(v).toLowerCase().replace(/[^a-z]+/g,"_").replace(/^_|_$/g,"");
 return ({booked:"scheduled",appointment_booked:"scheduled",appointment_scheduled:"scheduled",scheduled:"scheduled",rescheduled:"rescheduled",appointment_rescheduled:"rescheduled",cancelled:"cancelled",canceled:"cancelled",appointment_cancelled:"cancelled",appointment_canceled:"cancelled",completed:"completed",service_completed:"completed",job_complete:"completed"} as Record<string,string>)[k]||"";
}
function dateOnly(raw:unknown){
 const v=value(raw);
 if(/^\d{4}-\d{2}-\d{2}$/.test(v))return v;
 const us=v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
 if(us)return us[3]+"-"+us[1].padStart(2,"0")+"-"+us[2].padStart(2,"0");
 return "";
}
Deno.serve(async req=>{
 if(req.method!=="POST")return respond({ok:false,error:"POST required"},405);
 if(!secret)return respond({ok:false,error:"Receiver not configured"},503);
 const supplied=req.headers.get("x-ripple-secret")||"";
 // Constant-time equality for the shared server secret.
 const a=new TextEncoder().encode(secret),b=new TextEncoder().encode(supplied);
 if(a.length!==b.length || !crypto.timingSafeEqual(a,b))return respond({ok:false,error:"Unauthorized"},401);
 let d:Record<string,unknown>;
 try{d=await req.json();if(!d||typeof d!=="object"||Array.isArray(d))throw Error();}catch{return respond({ok:false,error:"Invalid JSON"},400);}
 const x=(d.customData && typeof d.customData==="object" && !Array.isArray(d.customData)?d.customData:{}) as Record<string,unknown>;
 const office=value(d.officeID||d.officeId||x.officeID);
 const appointment=value(d.appointmentID||d.appointmentId||x.appointment_id);
 const event=eventName(d.eventType||d.event||x.event);
 const serviceDate=dateOnly(d.serviceDate||x.service_date);
 if(!office||!appointment||!event)return respond({ok:false,error:"officeID, appointmentID and event are required"},422);
 if(office.length>80||appointment.length>100)return respond({ok:false,error:"Identifier too long"},422);
 if(event!=="cancelled" && !serviceDate)return respond({ok:false,error:"Explicit serviceDate (YYYY-MM-DD) required"},422);
 const {data:configs,error:lookupErr}=await db.from("config").select("location_id,paused,timezone,review_hour,radius_count").eq("fieldroutes_office_id",office).limit(2);
 if(lookupErr)return respond({ok:false,error:"Location lookup failed"},500);
 if(!configs||configs.length!==1)return respond({ok:false,error:"FieldRoutes officeID is not mapped to exactly one Ripple Location",officeID:office},422);
 const cfg=configs[0],locationId=cfg.location_id;
 if(cfg.paused)return respond({ok:true,skipped:"location_paused",locationId});
 const key="fr:appt:"+appointment;
 const {data:existing,error:priorErr}=await db.from("jobs").select("id,completed_at,service_date").eq("location_id",locationId).eq("ghl_job_id",key).maybeSingle();
 if(priorErr)return respond({ok:false,error:"Unable to resolve appointment"},500);
 const audit=async(status:string,reason:string|null,jobId:number|null)=>{
   const {error}=await db.from("ripple_appointment_sync_events").insert({location_id:locationId,office_id:office,appointment_id:appointment,event_type:event,status,reason,job_id:jobId});
   if(error)console.error("appointment audit error",error.message);
 };
 try{
   if(event==="cancelled"){
     if(!existing){await audit("processed","no_existing_appointment",null);return respond({ok:true,changed:false,reason:"No existing appointment"});}
     const {data:q,error:qErr}=await db.from("send_queue").select("id,status").eq("location_id",locationId).eq("job_id",existing.id).maybeSingle();
     if(qErr)throw qErr;
     if(q && ["sent","sending"].includes(q.status)){await audit("rejected","already_sending",existing.id);return respond({ok:false,error:"Mailing already in progress; cancellation requires manual review"},409);}
     if(q && !["skipped","failed"].includes(q.status)){
       const {error}=await db.from("send_queue").update({status:"skipped",approved_cards:0,skip_reason:"fieldroutes_appointment_cancelled",decided_at:new Date().toISOString()}).eq("id",q.id).in("status",["pending","approved"]);
       if(error)throw error;
     }
     await audit("processed",null,existing.id);
     return respond({ok:true,event,locationId,jobId:existing.id});
   }
   const address=value(d.address||d.address1),postal=value(d.zip||d.postal_code),city=value(d.city),region=value(d.state);
   if(!address||!postal||!city||!region)return respond({ok:false,error:"Service address, city, state and ZIP are required"},422);
   if(event==="scheduled"||event==="rescheduled"){
     if(existing?.completed_at){await audit("duplicate","already_completed",existing.id);return respond({ok:true,unchanged:true,reason:"Already completed"});}
   }
   // Existing job identity is stable for booking, rescheduling and completion.
   const hash=await addressHash(address,postal);
   if(!hash) return respond({ok:false,error:"Address could not be normalized"},422);
   const rawTech=value(d.techName||d.servicedBy),techId=value(d.techID||d.techId||d.techEmail||d.servicedBy||rawTech);
   const technicians=rawTech?[{id:techId||rawTech,name:rawTech}]:[];
   const payload:Record<string,unknown>={location_id:locationId,ghl_job_id:key,fieldroutes_appointment_id:appointment,service_address:address,city,region,postal_code:postal,addr_hash:hash,service_date:serviceDate,assigned_technicians:technicians,technician_source:technicians.length?"fieldroutes":null};
   if(event==="completed")payload.completed_at=new Date().toISOString();
   // Never overwrite the completion timestamp when receiving an ordinary booking.
   let jobId:number;
   if(existing){
     jobId=existing.id;
     if(event==="completed" && existing.completed_at) {await audit("duplicate","completed_already",jobId);return respond({ok:true,unchanged:true,jobId});}
     const {error}=await db.from("jobs").update(payload).eq("id",jobId);
     if(error)throw error;
   }else{
     const {data:created,error}=await db.from("jobs").insert(payload).select("id").single();
     if(error)throw error;
     jobId=created.id;
   }
   // Mark the service address as an existing customer for suppression.
   const {error:cacheError}=await db.from("client_addresses").upsert({location_id:locationId,addr_hash:hash,source:"job",last_seen_at:new Date().toISOString()},{onConflict:"location_id,addr_hash"});
   if(cacheError)throw cacheError;
   const {data:queued,error:qError}=await db.from("send_queue").select("id,status,completed_at,approved_cards").eq("location_id",locationId).eq("job_id",jobId).maybeSingle();
   if(qError)throw qError;
   if(queued&&["sending","sent","skipped","failed"].includes(queued.status)){
     await audit("processed","queue_locked_"+queued.status,jobId);
     return respond({ok:true,event,locationId,jobId,queueStatus:queued.status,unchanged:true});
   }
   // Compute an explicit review deadline anchored to the service day, not the arrival time.
   const hour=Math.max(0,Math.min(23,Number(cfg.review_hour??10)));
   const anchor=new Date(serviceDate+"T12:00:00Z");
   anchor.setUTCDate(anchor.getUTCDate()+1);
   const tomorrow=anchor.toISOString().slice(0,10);
   const tz=value(cfg.timezone)||"America/New_York";
   // Timezone-aware UTC conversion via local hour offset in Intl.DateTimeFormat.
   const instant=new Date(tomorrow+"T"+String(hour).padStart(2,"0")+":00:00Z");
   const parts=new Intl.DateTimeFormat("en-US",{timeZone:tz,timeZoneName:"shortOffset",hour:"2-digit"}).formatToParts(instant);
   const match=(parts.find(p=>p.type==="timeZoneName")?.value||"GMT").match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
   const offset=match?(match[1]==="-"?-1:1)*(Number(match[2])*60+Number(match[3]||0)):0;
   const deadline=new Date(instant.getTime()-offset*60000).toISOString();
   const updates={location_id:locationId,job_id:jobId,service_date:serviceDate,service_address:address,neighborhood:city,completed_at:event==="completed"?new Date().toISOString():null,review_deadline:deadline,proposed_cards:Number(cfg.radius_count??20),assigned_technicians:technicians,technician_source:technicians.length?"fieldroutes":null};
   if(queued){
     const {error}=await db.from("send_queue").update(updates).eq("id",queued.id).in("status",["pending","approved"]);
     if(error)throw error;
   }else{
     const {error}=await db.from("send_queue").insert({...updates,batch_id:"B"+serviceDate.replaceAll("-","")+"-"+jobId,status:"pending"});if(error)throw error;
   }
   await audit("processed",null,jobId);
   return respond({ok:true,event,locationId,jobId,serviceDate,mailingEligible:event==="completed"});
 }catch(err){
   await audit("error",err instanceof Error?err.message.slice(0,180):"unknown",existing?.id||null);
   console.error("matrix appointment sync",err);
   return respond({ok:false,error:"Appointment sync failed; safe to retry"},500);
 }
});