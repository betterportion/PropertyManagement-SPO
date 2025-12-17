# Property Management Dashboard

## Overview
This is a comprehensive property management system for Saint Paul's Outreach, Inc. (SPO), designed to streamline administrative tasks and resident interactions. The application provides role-based dashboards for administrators and residents, enabling admins to manage properties, maintenance, assets, billing, and vendors, while residents can submit and track maintenance requests. The system emphasizes efficiency, data density, and professional trustworthiness crucial for property management operations.

## Recent Changes (December 17, 2025)
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
- **Design Principles**: Role-based navigation, information-dense layouts, consistent spacing, responsive grid layouts, hover/active state elevation.

### Backend Architecture
- **Server Framework**: Express.js on Node.js with TypeScript, ESM module system.
- **API Design**: RESTful API under `/api`, session-based authentication, JSON format, centralized error handling.
- **Authentication & Authorization**: OpenID Connect (OIDC) with Replit Auth, Passport.js, express-session with PostgreSQL store, role-based access control (admin, regional_administrator, resident), fine-grained database-stored permissions.
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