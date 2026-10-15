
create table if not exists public.ripple_postcard_brand_defaults (
  brand_key text primary key,
  display_name text not null,
  postcard_mode text not null default 'creative' check (postcard_mode in ('creative','templates')),
  creative_id bigint,
  image_template_id bigint,
  message_template_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint postcard_brand_config_valid check (
    (postcard_mode='creative' and creative_id > 0)
    or (postcard_mode='templates' and image_template_id > 0 and message_template_id > 0)
  )
);
alter table public.ripple_postcard_brand_defaults enable row level security;
alter table public.config add column if not exists postcard_mode text not null default 'legacy' check(postcard_mode in ('legacy','brand_default','creative','templates'));
alter table public.config add column if not exists postcard_brand_key text references public.ripple_postcard_brand_defaults(brand_key);
alter table public.config add column if not exists postcard_creative_id bigint;
alter table public.config add column if not exists postcard_image_template_id bigint;
alter table public.config add column if not exists postcard_message_template_id bigint;
alter table public.config add constraint config_postcard_mode_valid check (
  (postcard_mode <> 'creative' or postcard_creative_id > 0)
  and (postcard_mode <> 'templates' or (postcard_image_template_id > 0 and postcard_message_template_id > 0))
  and (postcard_mode <> 'brand_default' or postcard_brand_key is not null)
);
insert into public.ripple_postcard_brand_defaults
 (brand_key,display_name,postcard_mode,creative_id,image_template_id,message_template_id)
values ('ma_pa','Mosquito & Pest Authority','creative',399995,425257,668546)
on conflict (brand_key) do nothing;
