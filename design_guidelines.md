# Property Management Dashboard - Design Guidelines

## Design Approach

**Selected Approach:** Design System (Productivity-Focused)

**Rationale:** This is a data-heavy, utility-focused application prioritizing efficiency and information density. Drawing inspiration from modern admin dashboards like Linear, Notion, and property management tools like Buildium.

**Core Principles:**
- Professional trustworthiness for property management context
- Clear role-based navigation (resident vs admin views)
- Efficient data scanning and form completion
- Consistent patterns for reduced cognitive load

## Typography

**Font System:** Inter (via Google Fonts CDN)
- Headers: 600-700 weight, sizes from text-2xl to text-4xl
- Body text: 400 weight, text-sm to text-base
- Labels/metadata: 500 weight, text-xs to text-sm
- Data tables: 400-500 weight, text-sm for optimal scanning

**Hierarchy:**
- Dashboard titles: text-3xl, font-semibold
- Section headers: text-xl, font-semibold
- Card titles: text-lg, font-medium
- Form labels: text-sm, font-medium
- Body/descriptions: text-sm, font-normal

## Layout System

**Spacing Primitives:** Tailwind units of 2, 4, 6, 8, and 12
- Component padding: p-4 to p-6
- Section margins: mb-6 to mb-8
- Card spacing: space-y-4
- Form field gaps: gap-4
- Table cell padding: p-4

**Grid Structure:**
- Main layout: Sidebar (w-64) + Content area (flex-1)
- Dashboard cards: grid-cols-1 md:grid-cols-2 lg:grid-cols-3
- Asset tables: full-width with horizontal scroll on mobile
- Forms: max-w-2xl single column

## Component Library

### Navigation
**Sidebar (Admin):**
- Fixed left sidebar with logo at top
- Icon + label navigation items (h-12 each)
- Active state with subtle background
- Sections: Dashboard, Maintenance, Walkthroughs, Assets, Billing, Contacts
- Role indicator badge at bottom

**Top Bar (Resident):**
- Horizontal navigation with property selector
- User profile dropdown (right-aligned)
- Simplified menu: Dashboard, Submit Request, My Requests

### Core Components

**Data Tables:**
- Striped rows for readability
- Sticky header on scroll
- Action buttons (icon-only) in rightmost column
- Sort indicators in column headers
- Hover state for rows
- Status badges (color-coded: pending, in progress, completed)

**Cards:**
- Rounded corners (rounded-lg)
- Subtle border (border)
- Padding: p-6
- Header with title + optional action button
- Content area with consistent spacing

**Forms:**
- Label above input pattern
- Input height: h-10
- Textarea: min-h-32
- Select dropdowns with icons
- File upload with drag-and-drop zone
- Submit button: full-width on mobile, auto on desktop

**Status Badges:**
- Pill shape (rounded-full)
- Small text (text-xs)
- Padding: px-3 py-1
- Used for request status, asset condition, payment status

**Image Gallery (Walkthroughs):**
- Grid layout: grid-cols-2 md:grid-cols-3 lg:grid-cols-4
- Aspect ratio maintained (aspect-square)
- Lightbox modal for full view
- Upload button prominent in empty state

**Asset Cards:**
- Two-column layout: Fixed Assets | Movable Assets
- Nested lists with expandable categories
- Metadata: Last serviced, condition, serial number
- Quick action menu (3-dot icon)

### Dashboards

**Admin Dashboard:**
- Summary cards row (3-4 cards): Total Properties, Active Requests, Overdue Invoices, Assets
- Recent maintenance requests table (5-10 rows)
- Upcoming walkthroughs calendar widget
- Quick actions sidebar

**Resident Dashboard:**
- Welcome header with property name
- Active requests status (card grid)
- Submit request CTA (prominent button)
- Property information card
- Contact emergency maintenance (always visible)

### Data Visualization
- Simple progress bars for completion rates
- Icon-based statistics (number with icon)
- Minimal charts if needed (bar/line only)

## Images

**Not Applicable:** This is a dashboard application focused on user-generated data (maintenance photos, asset photos). No hero images or marketing imagery needed. All images are functional uploads within galleries and asset tracking.

## Accessibility & Interaction

- Focus states on all interactive elements (ring-2 ring-offset-2)
- Keyboard navigation throughout
- Clear button hierarchy (primary vs secondary actions)
- Form validation with inline error messages
- Loading states for async operations
- Empty states with helpful CTAs

## Animations

**Minimal, purposeful only:**
- Sidebar collapse/expand (transition-transform duration-200)
- Dropdown menus (fade + slide)
- Modal overlays (fade backdrop + scale content)
- No scroll animations or decorative motion