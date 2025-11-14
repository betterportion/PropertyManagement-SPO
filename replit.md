# Property Management Dashboard

## Overview

This is a comprehensive property management system built for Saint Paul's Outreach, Inc. (SPO). The application enables administrators to manage multiple properties, track maintenance requests, conduct property walkthroughs, manage assets, handle billing for residents, and maintain vendor contacts. Residents have a simplified view where they can submit and track their own maintenance requests.

The system is designed as a role-based dashboard with distinct admin and resident experiences, emphasizing efficiency, data density, and professional trustworthiness appropriate for property management operations.

## Recent Changes

### November 14, 2025 - Maintenance Frontend Implementation
- **Page Architecture:**
  - Card-based design displaying all maintenance requests
  - Region and building filtering with client-side filtering logic
  - Tab-based status filtering (All, Pending, In Progress, Completed)
  - Search functionality across title and description
  - Grid layout of request cards showing title, category, priority, status, location
- **Components Created:**
  - **MaintenanceRequestCard**: Information-dense card with color-coded priority badges
  - **MaintenanceEditDialog**: Comprehensive edit form for all request fields
  - **Maintenance Page**: Main page with filters, tabs, and request grid
- **Edit Functionality:**
  - Full editing of title, description, category, priority, status
  - Location details (location, region, building)
  - Cost estimate, completion date tracking
  - Notes field for additional details
  - Contact linking - displays available maintenance contacts
  - Invoice linking - shows related invoices with create option
- **Wishlist Priority:**
  - Gold/yellow color coding (bg-yellow-500) for wishlist priority
  - Displays throughout UI in badges and edit form
  - All 5 priority levels supported (low, medium, high, urgent, wishlist)
- **Data Flow:**
  - React Query for data fetching from `/api/maintenance-requests`
  - Permissions fetched from `/api/users/:id/permissions` endpoint
  - PATCH mutations to update requests
  - Automatic cache invalidation after updates
- **Permission Integration:**
  - `canManageMaintenance` controls edit/delete actions
  - Read-only view for users without manage permissions
  - Admins have full management access
- **E2E Testing:**
  - Verified OIDC authentication flow
  - Tested maintenance request CRUD operations
  - Validated wishlist priority displays with gold color
  - Confirmed edit dialog updates priority and status correctly
- **Route Fix:**
  - Standardized on `/api/maintenance-requests` endpoint naming (was `/api/maintenance`)

### November 14, 2025 - Walkthroughs Frontend Implementation
- **Page Architecture:**
  - Room-centric design: browse rooms first, then view photos for each room
  - Region and building filtering with client-side filtering logic
  - Grid layout of room cards showing name, building address, and required question count
  - Click room to open detail drawer with lazy-loaded photos
- **Components Created:**
  - **PhotoGallery**: Reusable photo viewer/editor with permission-gated upload/delete/edit operations
  - **RoomCard**: Information-dense card showing room summary with click to expand
  - **RoomDetailDrawer**: Sheet component displaying required questions list and photo gallery with notes editing
  - **Walkthroughs Page**: Main page with region/building selectors and room grid display
- **Data Flow:**
  - React Query for data fetching with lazy loading of photos per room
  - Permissions fetched from `/api/users/:id/permissions` endpoint
  - Region filtering works by checking photo regions (since rooms lack region field in schema)
  - Building filtering uses buildingAddress as unique identifier
- **Permission Integration:**
  - `canManageWalkthroughs` controls upload/edit/delete actions
  - Read-only view for users without manage permissions
  - Admin and steward roles have full management access
- **E2E Testing:**
  - Verified OIDC authentication flow
  - Tested room and photo CRUD operations
  - Validated filtering by region and building
  - Confirmed photo notes editing persists correctly

### November 14, 2025 - Complete Backend API Implementation
- **API Routes:**
  - Comprehensive RESTful routes for maintenance requests, walkthroughs (rooms + photos), appliances/assets, contacts, invoices, and billing
  - All routes protected with isAuthenticated middleware and role-based permissions
  - Request validation using Zod schemas with .partial() for PATCH operations
  - Proper 403 Forbidden and 404 Not Found responses
  - filterUndefined helper prevents NULL overwrites on partial updates
- **Permission Model:**
  - View permissions for GET operations (canViewMaintenance, canViewWalkthroughs, canViewAssets, canViewContacts, canViewBilling)
  - Manage permissions for write operations (canManageMaintenance, canManageWalkthroughs, canManageAssets, canManageContacts, canManageBilling)
  - Stewards granted canManageWalkthroughs to enable photo note-taking capability
  - All routes validate isActive status before granting access

### November 14, 2025 - Authentication System Implementation
- **Replit Auth Integration:** Implemented OpenID Connect authentication with Replit Auth, supporting Google, GitHub, X, Apple, and email/password login methods
- **Database Schema Updates:**
  - Added `sessions` table for server-side session storage with automatic expiration
  - Added `users` table with role-based access (admin/resident)
  - Added `userPermissions` table for fine-grained permission control
- **Frontend Changes:**
  - Created landing page for unauthenticated users featuring SPO branding and feature showcase
  - Implemented `useAuth` hook with proper 401 handling for logged-out state
  - Added role-based routing (admin vs resident views)
  - Built Settings page for admin user management
- **Backend Changes:**
  - Implemented protected API routes with `isAuthenticated` middleware
  - Created user management endpoints (role updates, status control, permissions)
  - Configured session cookies to work in development environment
  - Added route guards to protect admin-only endpoints
- **Security Improvements:**
  - Session cookies with httpOnly flag and 7-day TTL
  - Secure cookies in production, non-secure in development for local testing
  - Role-based access control for all admin features
  - Cascade deletion of user permissions when users are deleted

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture

**Framework & Build Tools:**
- React with TypeScript for type safety
- Vite as the build tool and development server
- Wouter for client-side routing (lightweight alternative to React Router)
- TanStack Query (React Query) for server state management and caching

**UI Component System:**
- Shadcn/ui component library (New York style variant) for consistent, accessible UI components
- Radix UI primitives as the foundation for interactive components
- Tailwind CSS for utility-first styling
- Custom design system inspired by Linear/Notion with focus on productivity and data density
- Inter font family from Google Fonts for typography
- Dark mode support with theme toggle functionality

**State Management Approach:**
- Server state handled via TanStack Query with conservative caching (staleTime: Infinity)
- Local component state using React hooks
- Authentication state derived from `/api/auth/user` endpoint query
- Form state managed with React Hook Form and Zod validation

**Design Principles:**
- Role-based navigation (separate admin and resident views)
- Information-dense layouts optimized for scanning
- Consistent spacing using Tailwind primitives (2, 4, 6, 8, 12)
- Responsive grid layouts with mobile-first approach
- Hover and active state elevation effects for interactive feedback

### Backend Architecture

**Server Framework:**
- Express.js running on Node.js
- TypeScript for type safety across the stack
- ESM module system throughout

**API Design:**
- RESTful API endpoints under `/api` prefix
- Session-based authentication (no token-based auth)
- JSON request/response format
- Centralized error handling with status codes

**Authentication & Authorization:**
- OpenID Connect (OIDC) integration with Replit's authentication service
- Passport.js for authentication middleware
- Session management using express-session with PostgreSQL session store (connect-pg-simple)
- Role-based access control (admin vs resident roles)
- Fine-grained permissions system stored in database (userPermissions table)
- Session cookies with httpOnly and secure flags, 7-day TTL

**Database Layer:**
- Drizzle ORM for type-safe database operations
- PostgreSQL database via Neon serverless driver
- WebSocket support for Neon's serverless connections
- Schema-first approach with shared types between client and server
- Database migrations managed through Drizzle Kit

### Data Storage Solutions

**Database Schema:**
- `sessions` table for server-side session storage with automatic expiration
- `users` table with fields: id, email, firstName, lastName, profileImageUrl, role (admin/resident), isActive flag
- `userPermissions` table for granular permission control with foreign key to users (cascade delete)
- `maintenanceRequests` table with wishlist priority option (color-coded gold), status tracking, cost, submittedBy email
- `walkthroughRooms` table with region, building address, room name, required questions array, condition dropdown, optional notes
- `walkthroughPhotos` table with photoUrl, captions, linked to rooms for visual documentation
- `assets` table (Appliances/Fixed Assets) with ageInYears stored as integer for age-based tracking
- `maintenanceContacts` table for vendor management with company name, contact person, specialty, phone, email
- `invoices` table with separate section, linked to contacts (contactId) and maintenance requests (maintenanceRequestId optional)
- `billingRecords` table for resident billing with amount, description, resident email, payment status

**ORM Strategy:**
- Drizzle ORM chosen for type safety and performance
- Schema definitions in TypeScript generate both runtime validators and types
- Zod schemas derived from Drizzle schemas for validation
- Storage abstraction layer (IStorage interface) for potential future database migrations

**Connection Management:**
- Connection pooling via Neon's Pool
- Environment-based DATABASE_URL configuration
- WebSocket constructor override for serverless compatibility

### External Dependencies

**Third-Party Services:**
- Replit OIDC for authentication (discovery URL: https://replit.com/oidc)
- Neon Serverless PostgreSQL for database hosting
- Google Fonts CDN for Inter font family

**Key NPM Packages:**
- `@neondatabase/serverless` - Serverless PostgreSQL client
- `drizzle-orm` & `drizzle-kit` - ORM and migration tools
- `express` & `express-session` - Server framework and session management
- `passport` & `openid-client` - Authentication
- `react`, `react-dom` - Frontend framework
- `@tanstack/react-query` - Server state management
- `wouter` - Lightweight routing
- `@radix-ui/*` - Accessible component primitives
- `tailwindcss` - Utility-first CSS
- `zod` - Runtime validation
- `react-hook-form` - Form management
- `date-fns` - Date utilities

**Development Tools:**
- TypeScript for static typing
- ESBuild for production server bundling
- Vite plugins for Replit integration (runtime error overlay, cartographer, dev banner)
- PostCSS with Autoprefixer for CSS processing

**Asset Management:**
- Static assets served from `/attached_assets` directory
- Vite handles client-side asset bundling
- SPO logo included as primary branding element