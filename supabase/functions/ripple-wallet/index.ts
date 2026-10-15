import { createClient } from "jsr:@supabase/supabase-js@2";
const url=Deno.env.get("SUPABASE_URL")!;
const anon=Deno.env.get("SUPABASE_ANON_KEY")!;
const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const root=createClient(url,service,{auth:{persistSession:false}});
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization,apikey,content-type","Access-Control-Allow-Methods":"POST,OPTIONS"};
function send(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers:{...cors,"Content-Type":"application/json"}});}
Deno.serve(async(req)=>{
 if(req.method==="OPTIONS") return new Response(null,{headers:cors});
 if(req.method!=="POST") return send({error:"POST required"},405);
 try{
  const bearer=req.headers.get("Authorization")?.match(/^Bearer (.+)$/i)?.[1];
  if(!bearer) return send({error:"Login required"},401);
  const auth=createClient(url,anon,{auth:{persistSession:false}});
  const {data:{user},error:uErr}=await auth.auth.getUser(bearer);
  if(uErr||!user) return send({error:"Invalid session"},401);
  const body=await req.json();
  const locationId=String(body.locationId||"").trim();
  if(!locationId) return send({error:"Location required"},400);
  const [{data:member,error:mErr},{data:admin,error:aErr}]=await Promise.all([
   root.from("tenant_users").select("role").eq("location_id",locationId).eq("user_id",user.id).maybeSingle(),
   root.from("app_users").select("is_super_admin").eq("id",user.id).maybeSingle()
  ]);
  if(mErr||aErr||(!member&&!admin?.is_super_admin)) return send({error:"Not authorized for this Ripple location"},403);
  const {data:cfg,error:cErr}=await root.from("config").select("location_id,client_name,billing_mode,billing_ghl_contact_id,billing_payment_page_url,beta_billing_enabled,low_balance_alert_cents").eq("location_id",locationId).maybeSingle();
  if(cErr||!cfg) return send({error:"Location not configured"},404);
  if(body.action==="overview"){
   const {data:entries,error:eErr}=await root.from("billing_ledger").select("id,kind,amount_cents,description,created_at,external_ref").eq("location_id",locationId).order("created_at",{ascending:false}).limit(50);
   if(eErr) throw eErr;
   const {data:pending,error:pErr}=await root.from("ripple_wallet_topup_requests").select("id,amount_cents,status,created_at,paid_at").eq("location_id",locationId).order("created_at",{ascending:false}).limit(15);
   if(pErr) throw pErr;
   const {data:balance,error:bErr}=await root.rpc("location_balance_cents",{p_location_id:locationId});
   if(bErr) throw bErr;
   return send({ok:true,balanceCents:Number(balance??0),currency:"USD",billingMode:cfg.billing_mode,betaEnabled:!!cfg.beta_billing_enabled,billingContactConfigured:!!cfg.billing_ghl_contact_id,checkoutReady:!!cfg.beta_billing_enabled&&!!cfg.billing_ghl_contact_id,checkoutMode:"highlevel_form_test",lowBalanceAlertCents:cfg.low_balance_alert_cents,transactions:entries||[],topupRequests:pending||[]});
  }
  if(body.action==="request_topup"){
   if(!member||member.role!=="admin"){if(!admin?.is_super_admin)return send({error:"Only location admins can request wallet top-ups"},403);}
   if(!cfg.beta_billing_enabled) return send({error:"Beta billing is not enabled for this location"},409);
   if(!cfg.billing_ghl_contact_id) return send({error:"Billing Contact ID is not configured"},409);
   const cents=Number(body.amountCents);
   if(!Number.isSafeInteger(cents)||cents<1000||cents>500000) return send({error:"Amount must be between $10 and $5,000"},400);
   // All identifying parameters are UNTRUSTED on the hosted form. A successful
   // HighLevel payment must later be independently verified before credit.
   const {data:created,error:err}=await root.from("ripple_wallet_topup_requests").insert({location_id:locationId,initiated_by:user.id,amount_cents:cents,billing_ghl_contact_id:cfg.billing_ghl_contact_id,status:"awaiting_payment",checkout_started_at:new Date().toISOString()}).select("id,status,amount_cents").single();
   if(err) throw err;
   const target = "https://link.ripple.bizlabsolutions.ai/widget/form/HYhVWZ3kXHg2sNj1WBui";
   const checkout=new URL(target);
   checkout.searchParams.set("notrack","true");
   checkout.searchParams.set("ripple_location_id",locationId);
   checkout.searchParams.set("billing_contact_id",cfg.billing_ghl_contact_id);
   checkout.searchParams.set("ripple_top_up_request_id",created.id);
   checkout.searchParams.set("franchisee_name",cfg.client_name||"");
   // Query-key to HighLevel hidden-field mapping still needs a live form test.
   // Amounts remain customer-selected on the form, not forced by this URL.
   return send({ok:true,request:created,checkoutUrl:checkout.toString(),checkoutReady:true,formPrefillUnverified:true,message:"Payment form opened in test mode. Your Ripple balance will update only after the payment is independently verified."},202);
  }
  return send({error:"Unknown action"},400);
 }catch(e){console.error("[wallet]",e);return send({error:"Unable to process wallet request"},500);}
});