# Property Management Dashboard

## Overview
This is a comprehensive property management system for Saint Paul's Outreach, Inc. (SPO), designed to streamline administrative tasks and resident interactions. The application provides role-based dashboards for administrators and residents, enabling admins to manage properties, maintenance, assets, billing, and vendors, while residents can submit and track maintenance requests. The system emphasizes efficiency, data density, and professional trustworthiness crucial for property management operations.

## First-Run Setup

Follow these steps when cloning this repository into a fresh environment (including a new Replit workspace or a local checkout from GitHub).

### 1. Install dependencies
```bash
npm install
```

### 2. Set required environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | **Yes** | PostgreSQL connection string (Neon serverless) |
| `SESSION_SECRET` | **Yes** | Long random string used to sign session cookies |
| `REPL_ID` | On Replit only | Auto-provided by Replit; used as the OIDC client ID unless `OIDC_CLIENT_ID` is set |
| `OIDC_ISSUER_URL` | No | Identity provider discovery root. Defaults to `https://replit.com/oidc` |
| `OIDC_CLIENT_ID` | No | Client ID from your identity provider. Overrides `REPL_ID` |
| `OIDC_CLIENT_SECRET` | No | Client secret, if your provider issues one. Replit does not use one |
| `OIDC_PROVIDER_NAME` | No | Internal login strategy prefix only; defaults to `replitauth` |
| `OIDC_SCOPES` | No | Space-separated scopes; defaults to `openid email profile offline_access` |
| `ISSUER_URL` | No | Legacy alias for `OIDC_ISSUER_URL`; still honoured |
| `MONDAY_API_KEY` | No | Monday.com sync; the feature is silently skipped if unset |
| `JOTFORM_WEBHOOK_SECRET` | Recommended | Shared secret for the JotForm webhook endpoint |
| `JOTFORM_FIELD_*` | No | JotForm field ID mappings (TITLE, DESCRIPTION, CATEGORY, PRIORITY, LOCATION, EMAIL, REGION, BUILDING) |
| `JOTFORM_DEFAULT_*` | No | Fallback values for JotForm submissions (REGION, BUILDING, LOCATION) |
| `PORT` | No | Defaults to 5000 |

### 3. Create the database schema — required before first start
The app will not start against an empty database, because the session store expects a `sessions` table to exist. Push the schema first:
```bash
npm run db:push
```

### 4. Start the app
```bash
npm run dev
```

### Notes for running outside Replit
- Authentication is standard OpenID Connect and is configurable — see "Swapping the identity provider" below. It defaults to Replit Auth, which requires `REPL_ID`.
- Uploaded files are stored in Replit App Storage, so they survive restarts and publishes. Running outside Replit requires replacing `server/objectStorage.ts` with an equivalent backed by your own object store.

## Swapping the identity provider

Login is standard OpenID Connect, and every provider-specific detail lives in one file: `server/auth.ts`. Nothing else in the server knows which provider is in use — route handlers call `getUserId(req)` and never read provider claims directly.

### What to configure
Point the app at a different provider by setting these. No code changes are required.

| Variable | Example |
|---|---|
| `OIDC_ISSUER_URL` | `https://your-tenant.auth0.com` |
| `OIDC_CLIENT_ID` | The client ID issued by the provider |
| `OIDC_CLIENT_SECRET` | The client secret, if the provider issues one |
| `OIDC_PROVIDER_NAME` | Any short label, e.g. `auth0` |

Then register `https://your-domain/api/callback` as an allowed redirect URI with the new provider, and `https://your-domain` as an allowed logout redirect.

### What already works with any provider
- **Claim names**: standard OIDC `given_name`, `family_name`, and `picture` are read when Replit's `first_name`, `last_name`, and `profile_image_url` are absent.
- **Logout**: providers that do not advertise an end-session endpoint are handled — the local session is cleared and the user returns to the home page instead of hitting an error.
- **Callback URL**: follows the protocol of the incoming request, so an `http://localhost` checkout can complete the login round trip.

### Important: what happens to existing accounts
User records are keyed on the provider's subject identifier (`sub`), so switching providers issues **new IDs for the same people**. The app already handles this: `upsertUser` in `server/storage.ts` detects a sign-in whose email matches an existing account under a different ID and migrates that account, preserving its role, active status, and permissions.

The practical migration path is therefore:
1. Confirm every user has the correct email address on their account **before** the switch.
2. Change the `OIDC_*` variables.
3. Have each user sign in once — their account re-links by email automatically.

Anyone whose record has no email, or who signs in with a different email than the one stored, arrives as a brand-new account with default resident permissions and has to be re-granted access by an admin.

## Recent Changes (July 30, 2026)
- **Portable Login**: Authentication is no longer hard-wired to Replit. The issuer, client ID and secret, scopes, and strategy naming all moved into configuration inside `server/auth.ts`, defaulting to the current Replit values so sign-in behaviour is unchanged. `server/replitAuth.ts` was renamed to `server/auth.ts` because it is no longer provider-specific
- **Single User Accessor**: The 49 route handlers that read `req.user.claims.sub` directly now call `getUserId(req)`, so the shape of provider data is referenced in exactly one place
- **Provider-Agnostic Behaviour**: Standard OIDC claim names are accepted alongside Replit's; logout tolerates providers without an end-session endpoint; the callback URL follows the request protocol
- **Docs**: Added the "Swapping the identity provider" section above, including what happens to existing accounts during a real switch

## Recent Changes (July 29, 2026)
- **Pre-Push Repo Cleanup**: Removed user-uploaded files and chat screenshots from git tracking (files remain on disk); expanded `.gitignore` to cover `uploads/`, `.env*`, `.cache/`, `.local/`, `.agents/`, and `attached_assets/`. The SPO logo is explicitly kept tracked because it is imported via the `@assets` alias by the sidebar and landing page
- **Dead Code Removal**: Deleted the orphaned `pages/Invoices.tsx` (not routed since the standalone Invoices section was removed in April), the entire `components/examples/` folder, and the now-unreferenced `components/ResidentBilling.tsx`. These were the source of all outstanding TypeScript errors — the type check now passes with zero errors
- **Documentation**: Added the First-Run Setup section above covering required environment variables and the mandatory `npm run db:push` before first start

## Recent Changes (April 20, 2026) — Part 2
- **Linked Contacts on Maintenance Requests**: Added full link/unlink support; new `request_contacts` join table in DB; storage methods `getRequestContacts`, `linkContactToRequest`, `unlinkContactFromRequest`; routes `GET/POST/DELETE /api/maintenance-requests/:id/contacts/:contactId`; `MaintenanceEditDialog` now shows all contacts as clickable toggle cards — highlighted with a check icon when linked, click again to unlink; badge shows linked count

## Recent Changes (April 20, 2026) — Part 1
- **Invoices Section Removed**: The standalone "Invoices" nav item and `/invoices` route have been removed entirely
- **Add Invoice Record Dialog**: Completely redesigned — now on the "Maint Contacts & Invoices" page; fields: Company Name, Email, Phone, Invoice Cost; Contact selection: toggle between "Select Existing" contact (dropdown auto-fills fields) or "New Contact" (creates a new contact in DB on submit); three document upload slots: Contract/Invoice, COI, W-9 (uploads to `/api/upload-doc`); new contacts are created with company name, email, phone
- **BillingRecords Schema**: Overhauled — removed resident/rent/region fields; new fields: contactId (nullable), companyName, email, phone, invoiceCost, contractInvoiceUrl, coiUrl, w9Url
- **Document Upload Endpoint**: Added `/api/upload-doc` accepting PDF, DOC, DOCX, image files up to 20MB
- **Settings Permissions**: Billing permissions (View/Manage Invoices) merged into the "Maint Contacts & Invoices" section
- **Landing Page**: Removed standalone "Billing" feature card; updated "Maint Contacts & Invoices" description to include billing

## Recent Changes (April 17, 2026)
- **JotForm Webhook Frontend**: Added "JotForm Setup" button (admin-only) to the Maintenance page header; clicking it opens a setup dialog with the copyable webhook URL, step-by-step JotForm integration instructions, and a field mapping table showing all `JOTFORM_FIELD_*` / `JOTFORM_DEFAULT_*` environment variables and their current values (fetched from `/api/webhooks/jotform/config`)

## Recent Changes (March 28, 2026)
- **Property Integration**: All sections now use real properties for dropdowns — Contacts and Invoices updated to source building address lists from `/api/properties` (Maintenance, Walkthroughs, Assets were already connected)
- **Contacts**: Region and Building Address fields in Add/Edit forms converted from free text inputs to Select dropdowns populated from the properties table; selecting a property auto-fills both fields
- **Invoices**: Removed all hardcoded mock data; now fetches real billing records from `/api/billing` and properties from `/api/properties`; added "Add Billing Record" dialog with full form including property, region, and building address dropdowns
- **Backend Permissions**: Contacts and Billing routes (GET/POST/PATCH/DELETE) now apply the `!isAdmin` bypass pattern — admin users are no longer blocked by permission DB record checks
- **Frontend Permissions**: Contacts and Invoices `canManage` checks now also read the user's role directly (admin/regional_administrator bypass regardless of DB permission state)
- **Maintenance Photo Upload**: Added optional photo attachment to the Create Maintenance Request form; `photoUrl` column added to `maintenance_requests` table; uploaded photos display on request cards
- **Asset Tracking Improvements**: Category converted to dropdown (10 preset options); Age and Last Serviced fields now only show for Fixed type assets; Purchase Price made required; Asset Tag ID added as required field; photo upload required when creating a new asset (saved to assetPhotos); `assetTagId` column added to assets table

## Recent Changes (March 12, 2026)
- **Bug Fix**: Properties page "Internal Server Error" resolved — admin bypass on GET /api/properties now correctly allows admins to view properties even without a DB permissions record
- **Residents**: `GET /api/maintenance-requests` now returns only the requesting user's own submissions for residents (previously returned empty list due to empty `allowedRegions`)
- **Residents**: `MyRequests` and `ResidentDashboard` pages now use real API data instead of hardcoded mock data
- **TypeScript**: Fixed `mondayItemId` type mismatch (null vs undefined) in `updateMaintenanceRequest` — both interface and implementation updated to accept `string | null`
- **Cleanup**: Removed unused `useAuth` import from Properties.tsx; deleted orphaned example component files with stale mock data
- **Auth Account Linking**: `upsertUser` now detects when a new OIDC sign-in's email matches an admin-pre-created account with a different ID — it migrates the old record to the OIDC sub, preserving role, active status, and all permissions. This fixes "Internal Server Error" on sign-in for pre-created users like laura.wilson@spo.org

## Previous Changes (March 2, 2026)
- **Monday.com Integration**: Maintenance requests now sync to Monday.com regional boards automatically
- **Monday.com**: New requests are created as items on the matching regional board (Maint - WC/SW/NW/SE/EC/NE)
- **Monday.com**: Status and priority updates in the app are pushed to Monday.com in real time
- **Monday.com**: `mondayItemId` stored on each maintenance request to link to the Monday.com item
- **Monday.com**: Auth handled via `MONDAY_API_KEY` secret; key-doubling bug auto-corrected in `server/monday.ts`
- **Properties**: Added square footage field (squareFootage integer) to schema, form, and card display
- **Properties**: Region field changed from free text to a dropdown with 7 preset options (alphabetical)
- **Walkthroughs**: Room detail drawer now has a full photo upload dialog (file picker, condition, location, notes)

## Previous Changes (December 17, 2025)
- **Photo Upload**: Added drag-and-drop photo upload component for Assets and Walkthroughs pages
- **Assets Photos**: New assetPhotos table with CRUD operations; Photos dialog accessible from asset menu
- **File Upload**: Server endpoint at /api/upload handles image files (JPEG, PNG, GIF, WebP) up to 10MB
- **Walkthroughs**: Photo upload dialog now uses file upload instead of URL input
- **Properties**: Separated address into components: streetAddress, city, state, zipCode
- **Properties**: Server automatically computes full address from components for display
- **Walkthroughs**: Building address dropdown now populated from Properties table instead of room data
- **Maintenance**: Location field converted from text input to dropdown showing current properties
- **Assets**: Removed location field; region and building address now use dropdowns (regions list and Properties table)
- **Contacts**: Removed duplicate "Add Contact" button; added Edit button with full edit dialog for updating contact info
- **Invoices**: Renamed "Billing" section to "Invoices" throughout navigation, routes, and page title
- **Schema**: Added InsertPropertyWithAddress type for proper type safety in property CRUD operations

## Previous Changes (November 19, 2025)
- **Maintenance**: Added admin "Create Request" button and dialog with full form validation
- **Priority Colors**: Updated badge colors - "high" uses destructive red, "urgent" uses bright red-600
- **Assets**: Added purchasePrice field (numeric 12,2) to schema, forms, and CRUD operations
- **Assets**: Fixed SelectItem error by filtering empty buildingAddress values from building list
- **Dashboard**: Replaced mock data with live API integration, wired up edit button to MaintenanceEditDialog
- **Walkthroughs**: Photo upload dialog automatically appears after room creation with full form (URL, condition, notes, region, building, location)
- **Schema**: Fixed insertMaintenanceRequestSchema to omit submittedDate (auto-populated by database)
- **Permissions**: Admin users granted full permissions for complete system access
- All features end-to-end tested and verified working correctly

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework & Build Tools**: React with TypeScript, Vite, Wouter for routing, TanStack Query for server state.
- **UI Component System**: Shadcn/ui (New York style), Radix UI primitives, Tailwind CSS for styling, Inter font, dark mode support.
- **State Management**: TanStack Query for server state (conservative caching), React hooks for local state, React Hook Form with Zod for form state.
- **Design Principles**: The portal follows the shared **SPO Design System** (`attached_assets/spo-design-system_1786056605884.md`), with portal-specific decisions recorded in `design_guidelines.md`. Outlined red calls to action, navy body text, bordered cards without shadows, 12px corners, light/dark/system themes. A live reference page for staff lives at `/styleguide`.

### Backend Architecture
- **Server Framework**: Express.js on Node.js with TypeScript, ESM module system.
- **API Design**: RESTful API under `/api`, session-based authentication, JSON format, centralized error handling.
- **Authentication & Authorization**: Standard OpenID Connect via Passport.js, configured through `OIDC_*` environment variables and defaulting to Replit Auth (see "Swapping the identity provider"). Express-session with a PostgreSQL store, role-based access control (admin, regional_administrator, resident), fine-grained database-stored permissions. Route handlers resolve the signed-in user only through `getUserId(req)` from `server/auth.ts`.
- **Database Layer**: Drizzle ORM for type-safe operations, PostgreSQL (Neon serverless driver), schema-first approach, Drizzle Kit for migrations.

### Data Storage Solutions
- **Database Schema**:
    - `sessions`: Server-side session storage.
    - `users`: User profiles, roles (admin, regional_administrator, resident), active status.
    - `userPermissions`: Granular permissions for features.
    - `maintenanceRequests`: Tracks requests with priority (including wishlist), status, cost, submitter.
    - `walkthroughRooms`: Details rooms with region, building, questions, condition, notes.
    - `walkthroughPhotos`: Stores photo URLs, captions, linked to rooms.
    - `assets`: Appliances/fixed assets with age tracking.
    - `assetPhotos`: Photos linked to assets, stores image URLs and captions.
    - `maintenanceContacts`: Vendor details.
    - `invoices`: Linked to contacts and maintenance requests.
    - `billingRecords`: Resident billing with amount, description, payment status.
    - `properties`: Property records with address components.
- **ORM Strategy**: Drizzle ORM for type safety and performance, Zod schemas for validation.
- **Connection Management**: Neon's Pool for connection pooling, environment-based `DATABASE_URL`.

## External Dependencies

### Third-Party Services
- **Replit OIDC**: For OpenID Connect authentication.
- **Neon Serverless PostgreSQL**: Database hosting.
- **Google Fonts CDN**: For Inter font family.

### Key NPM Packages
- `@neondatabase/serverless`: PostgreSQL client.
- `drizzle-orm`, `drizzle-kit`: ORM and migration tools.
- `express`, `express-session`: Server framework and session management.
- `passport`, `openid-client`: Authentication middleware.
- `react`, `react-dom`: Frontend framework.
- `@tanstack/react-query`: Server state management.
- `wouter`: Lightweight routing.
- `@radix-ui/*`: Accessible UI primitives.
- `tailwindcss`: Utility-first CSS.
- `zod`: Runtime validation.
- `react-hook-form`: Form management.
- `date-fns`: Date utilities.

### Development Tools
- **TypeScript**: Static typing.
- **ESBuild**: Production server bundling.
- **Vite plugins**: Replit integration (runtime error overlay, cartographer, dev banner).
- **PostCSS with Autoprefixer**: CSS processing.

### Asset Management
- Static assets served from `/attached_assets`.
- Vite handles client-side asset bundling.
- SPO logo as primary branding.