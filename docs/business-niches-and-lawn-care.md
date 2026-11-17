# Business niches and Lawn Care pages

Super Admin can maintain the business-niche catalog, its scratch-card and booking URLs, and location assignments. Initial niches are Lawn Care and Mosquito & Pest Control. Existing locations remain unassigned.

## HighLevel setup
Append `web/highlevel/shared/addons/business-niches.html` AFTER the existing four-tab Super Admin navigation. Do not replace the base admin page or remove its mailing, wallet or user-management addons.
Paste the Lawn Care fragments into these existing pages:
- https://ripple.bizlabsolutions.ai/lawn-care/scratch-card
- https://ripple.bizlabsolutions.ai/lawn-care/booking-now

The new tab includes add/edit niche forms, activation controls, location assignment, URL previews, and effective routing labels. A niche with assigned locations cannot be deactivated. Publish the actual customer pages before assigning a new niche.

## Routing
Location URL override > active niche URL > platform default.
The postcard sender resolves the URL for each new send. Printed QR links retain their original URL. No prize, mailing permission, wallet, calendar, logo or CRM mapping is copied between businesses when assigning a niche.

## Backend
Migration version 20261117113918 was already applied to Ripple in this session. Do not reapply it manually to the existing database.
The niche table has RLS enabled and no public or authenticated table grants. The new Edge Function verifies the caller's session and app_users.is_super_admin before reading or writing catalog/assignment data. Deploy with JWT verification enabled.
The sender and shared helpers in this commit are snapshots of the deployed source; the previous repository sender predates current safety and billing changes. These files must be kept together.

## Demo and fallback
Add ?demo=1 to either Lawn Care page for sample data without network writes. Scratch demo continues to the booking demo. Normal signed QR/token URLs use real Ripple data.
The scratch card uses the existing same-batch fallback-prize endpoint only after an inventory 409, with service-address capture for fallback visits. Invalid links never bypass signature validation. A generic quote form and location selector are not implemented because no Lawn Care businesses are onboarded yet.

## Verification and remaining work
JavaScript/TypeScript syntax and simulated scratch-card state checks passed. SQL routing checks confirmed niche defaults and custom URL precedence; test assignments were rolled back. Existing locations were not reassigned. Provider QR merge-marker formatting was checked without paid sends.
The Super Admin tab needs a live signed-in browser check after pasting. A real Lawn Care location and signed QR are needed for end-to-end claims/CRM testing. Source sync does not publish HighLevel pages or trigger deployments.
