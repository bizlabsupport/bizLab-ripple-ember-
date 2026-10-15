import { createClient } from "jsr:@supabase/supabase-js@2";
const base = Deno.env.get("SUPABASE_URL")!;
const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(base, secret, { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization,apikey,content-type", "Access-Control-Allow-Methods": "POST,OPTIONS" };
function respond(body: unknown, status = 200) { return new Response(JSON.stringify(body), {status, headers: {...cors, "Content-Type":"application/json"}}); }
const MAX = 2 * 1024 * 1024;
function decodeImage(encoded: string, mime: string): Uint8Array {
  if (encoded.length > Math.ceil(MAX * 4 / 3) + 32 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("Invalid image data or image exceeds 2 MB");
  const raw = atob(encoded);
  if (!raw.length || raw.length > MAX) throw new Error("Image must be between 1 byte and 2 MB");
  const bytes = Uint8Array.from(raw, x=>x.charCodeAt(0));
  const isPng = bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((x,i)=>bytes[i]===x);
  const isJpeg = bytes.length >= 4 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255;
  const isWebp = bytes.length >= 12 && new TextDecoder().decode(bytes.subarray(0,4))==="RIFF" && new TextDecoder().decode(bytes.subarray(8,12))==="WEBP";
  if (!(mime==="image/png" && isPng || mime==="image/jpeg" && isJpeg || mime==="image/webp" && isWebp)) throw new Error("Use a valid PNG, JPEG, or WebP file");
  return bytes;
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return respond({error:"POST required"},405);
  try {
    const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return respond({error:"Login required"},401);
    const auth = createClient(base, anon, {auth:{persistSession:false}});
    const {data:{user}, error:authError} = await auth.auth.getUser(token);
    if (authError || !user) return respond({error:"Invalid session"},401);
    const {data:adminUser,error:roleError} = await admin.from("app_users").select("is_super_admin").eq("id",user.id).maybeSingle();
    if (roleError || !adminUser?.is_super_admin) return respond({error:"Super Admin access required"},403);
    const payload = await req.json();
    const locationId = String(payload.locationId || "").trim();
    if (!locationId || locationId.length > 128) return respond({error:"Location required"},400);
    const {data:config,error:configError} = await admin.from("config").select("location_id,brand_logo_url").eq("location_id",locationId).maybeSingle();
    if (configError) throw configError;
    if (!config) return respond({error:"Location not found"},404);
    if (payload.action==="get") return respond({ok:true,logoUrl:config.brand_logo_url||null});
    if (payload.action==="remove") {
      const {error} = await admin.from("config").update({brand_logo_url:null}).eq("location_id",locationId);
      if (error) throw error;
      return respond({ok:true,logoUrl:null});
    }
    if (payload.action!=="upload") return respond({error:"Unknown action"},400);
    const mime = String(payload.mime || "");
    if (!["image/png","image/jpeg","image/webp"].includes(mime)) return respond({error:"PNG, JPG, or WebP only"},400);
    const content = decodeImage(String(payload.base64 || ""), mime);
    const extension = mime==="image/png"?"png":mime==="image/jpeg"?"jpg":"webp";
    const bytes = new TextEncoder().encode(locationId);
    const key = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))).map(x=>x.toString(16).padStart(2,"0")).join("");
    const path = key + "/" + crypto.randomUUID() + "." + extension;
    const {error:upError} = await admin.storage.from("ripple-brand-logos").upload(path,content,{contentType:mime,upsert:false,cacheControl:"31536000"});
    if (upError) throw upError;
    const {data:publicResult} = admin.storage.from("ripple-brand-logos").getPublicUrl(path);
    const logoUrl = publicResult.publicUrl;
    const {error:saveError} = await admin.from("config").update({brand_logo_url:logoUrl}).eq("location_id",locationId);
    if (saveError) { await admin.storage.from("ripple-brand-logos").remove([path]); throw saveError; }
    return respond({ok:true,logoUrl});
  } catch (error) {
    console.error("ripple-brand-logo",error);
    return respond({error:error instanceof Error && /^(Invalid image|Image must|Use a valid)/.test(error.message)?error.message:"Unable to save location logo"},500);
  }
});