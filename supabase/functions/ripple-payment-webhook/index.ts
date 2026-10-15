import { createClient } from "jsr:@supabase/supabase-js@2";
const url=Deno.env.get("SUPABASE_URL")!;
const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const expected=Deno.env.get("RIPPLE_PAYMENT_WEBHOOK_SECRET")||"";
const db=createClient(url,service,{auth:{persistSession:false}});
const reply=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{"Content-Type":"application/json"}});
function equal(a:string,b:string){if(!a||!b||a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;}
function val(x:unknown){return typeof x==="string" ? x.trim().slice(0,200) : "";}
Deno.serve(async req=>{
 if(req.method!=="POST")return reply({error:"POST required"},405);
 if(!expected)return reply({error:"Webhook receiver not configured"},503);
 if(!equal(req.headers.get("x-ripple-webhook-secret")||"",expected))return reply({error:"Unauthorized"},401);
 let b:Record<string,unknown>;
 try{b=await req.json();if(!b||typeof b!=="object"||Array.isArray(b))throw Error("invalid");}
 catch{return reply({error:"Invalid JSON"},400);}
 if(val(b.event)!=="ripple_wallet_topup")return reply({error:"Invalid event"},400);
 if(val(b.billing_location_id)!=="WzwhUvsDxq3KOUJqAjmJ")return reply({error:"Invalid billing account"},400);
 const tx=val(b.transaction_id), loc=val(b.ripple_location_id), contact=val(b.billing_contact_id), rawId=val(b.topup_request_id);
 const requestId=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawId)?rawId:null;
 const status=requestId&&tx?"awaiting_verification":"missing_reference";
 const audit={
  event:val(b.event),billing_location_id:val(b.billing_location_id),
  ripple_location_id:loc,billing_contact_id:contact,topup_request_id:rawId,
  transaction_id:tx,payment_status:val(b.payment_status),
  payment_amount:val(b.payment_amount),currency:val(b.currency),
  payment_gateway:val(b.payment_gateway),payment_method:val(b.payment_method)
 };
 // Workflow data is untrusted, including its "success" status and the amount.
 // NEVER credit billing_ledger here. Wait for a server-verified transaction,
 // matching location/contact/request, correct source/currency and live/test mode.
 const {error}=await db.from("ripple_payment_webhook_events").insert({
  transaction_id:tx||null,topup_request_id:requestId,billing_contact_id:contact||null,
  claimed_location_id:loc||null,status,payload:audit,
  rejection_reason:status==="missing_reference"?"Missing payment transaction ID or valid top-up request ID":null
 });
 if(error){console.error("[payment-webhook] audit insert failed",error.message);return reply({error:"Unable to record event"},500);}
 return reply({received:true,credited:false,verification:status},202);
});