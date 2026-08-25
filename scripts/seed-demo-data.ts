/**
 * Seeds a database with realistic demo data, for exploring the app locally or
 * proving out a fresh staging environment before real records exist.
 *
 *   DATABASE_URL=postgresql://... npm run db:seed
 *
 * Everything goes through the same storage layer the routes use, so the seed
 * exercises the real insert paths rather than bypassing them with SQL. Photo
 * records get a real (1×1 placeholder) image written through the configured
 * storage driver, so image URLs actually resolve in the UI.
 *
 * It refuses to run against a database that already has properties — there is
 * no flag to override that, because "re-seed" against real records is never
 * what anyone wants. To start over locally, drop and re-migrate the database.
 *
 * Optional: SEED_ADMIN_EMAIL=you@spo.org pre-creates an admin account under
 * that email. The first Google sign-in with that address re-links to it and
 * arrives as an admin instead of a resident (the account-linking behaviour
 * documented in CLAUDE.md), so nobody has to promote themselves with SQL.
 */
import { storage } from "../server/storage";
import { generateStorageKey, putUpload } from "../server/objectStorage";
import { closeDatabase } from "../server/db";

// A valid 1×1 PNG. Enough for <img> tags to render without broken-image icons.
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Stores a placeholder image and its uploads row; returns the /uploads URL. */
async function seedImage(originalName: string): Promise<string> {
  const storageKey = generateStorageKey(originalName);
  await putUpload(storageKey, PLACEHOLDER_PNG, {
    contentType: "image/png",
    originalName,
  });
  await storage.createUpload({
    storageKey,
    originalName,
    contentType: "image/png",
    sizeBytes: PLACEHOLDER_PNG.length,
    uploadedBy: "seed-script",
  });
  return `/uploads/${storageKey}`;
}

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
const daysAhead = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

async function seed(): Promise<void> {
  const existing = await storage.getAllProperties();
  if (existing.length > 0) {
    console.error(
      `This database already has ${existing.length} properties — refusing to seed on top of real data.\n` +
        "To start over locally, drop the database, re-run npm run db:migrate, then seed again.",
    );
    process.exitCode = 1;
    return;
  }

  // ── Properties ────────────────────────────────────────────────────────────
  const propertyRows = [
    { name: "Cleveland House", streetAddress: "1472 Cleveland Ave N", city: "St Paul", state: "MN", zipCode: "55108", region: "East Central", chapter: "University of St. Thomas", propertyManager: "Sarah Jenkins", bedrooms: 5, bathrooms: "2.0", squareFootage: 2400 },
    { name: "Como Men's House", streetAddress: "981 Como Ave", city: "St Paul", state: "MN", zipCode: "55103", region: "East Central", chapter: "University of Minnesota", propertyManager: "Sarah Jenkins", bedrooms: 6, bathrooms: "2.5", squareFootage: 2800 },
    { name: "Dinkytown Women's House", streetAddress: "615 8th Ave SE", city: "Minneapolis", state: "MN", zipCode: "55414", region: "West Central", chapter: "University of Minnesota", propertyManager: "Mark Otto", bedrooms: 4, bathrooms: "2.0", squareFootage: 1900 },
    { name: "Franciscan Commons", streetAddress: "210 University Blvd", city: "Steubenville", state: "OH", zipCode: "43952", region: "North East", chapter: "Franciscan University", propertyManager: "Angela Ruiz", bedrooms: 7, bathrooms: "3.0", squareFootage: 3200 },
    { name: "Aggieland House", streetAddress: "504 College Main St", city: "College Station", state: "TX", zipCode: "77840", region: "South West", chapter: "Texas A&M", propertyManager: "Mark Otto", bedrooms: 5, bathrooms: "2.0", squareFootage: 2200 },
    { name: "Badger House", streetAddress: "122 Langdon St", city: "Madison", state: "WI", zipCode: "53703", region: "North West", chapter: "UW–Madison", propertyManager: null, bedrooms: 6, bathrooms: "2.5", squareFootage: 2600 },
  ];

  const properties = [];
  for (const row of propertyRows) {
    properties.push(
      await storage.createProperty({
        ...row,
        address: `${row.streetAddress}, ${row.city}, ${row.state} ${row.zipCode}`,
      }),
    );
  }
  const [cleveland, como, dinkytown, franciscan, aggieland, badger] = properties;
  console.log(`Seeded ${properties.length} properties`);

  // ── Vendor contacts ───────────────────────────────────────────────────────
  const contactRows = [
    { name: "Tom Blake", company: "Blake Plumbing LLC", service: "Plumbing", phone: "651-555-0142", email: "office@blakeplumbing.com", region: cleveland.region, buildingAddress: cleveland.address },
    { name: "Rita Moreno", company: "TwinCities HVAC", service: "HVAC", phone: "612-555-0177", email: "dispatch@tchvac.com", region: como.region, buildingAddress: como.address },
    { name: "Dave Kowalski", company: "Kowalski Electric", service: "Electrical", phone: "608-555-0101", email: "dave@kowalskielectric.com", region: dinkytown.region, buildingAddress: dinkytown.address },
    { name: "Maria Santos", company: "Santos Appliance Repair", service: "Appliance", phone: "979-555-0166", email: "maria@santosrepair.com", region: aggieland.region, buildingAddress: aggieland.address },
    { name: "Ed Harmon", company: "Harmon Roofing & Gutters", service: "Structural", phone: "740-555-0133", email: "ed@harmonroofing.com", region: franciscan.region, buildingAddress: franciscan.address },
  ];
  const contacts = [];
  for (const row of contactRows) {
    contacts.push(await storage.createMaintenanceContact(row));
  }
  console.log(`Seeded ${contacts.length} vendor contacts`);

  // ── Maintenance requests ──────────────────────────────────────────────────
  const requestRows = [
    { title: "Kitchen faucet dripping constantly", description: "The cold tap drips even when fully closed. Bucket is filling overnight.", category: "Plumbing", priority: "high", status: "pending", property: cleveland, submittedBy: "joe.miller@spo.org" },
    { title: "Furnace making banging noise", description: "Loud metal bang when the heat kicks in, from the basement unit.", category: "HVAC", priority: "urgent", status: "in_progress", property: como, submittedBy: "sam.oconnor@spo.org" },
    { title: "Bedroom window won't latch", description: "Second-floor north bedroom window closes but the latch doesn't catch.", category: "Structural", priority: "medium", status: "pending", property: dinkytown, submittedBy: "clare.hughes@spo.org" },
    { title: "Dryer not heating", description: "Runs a full cycle but clothes come out cold and damp.", category: "Appliance", priority: "high", status: "in_progress", property: franciscan, submittedBy: "ben.walsh@spo.org" },
    { title: "Porch light flickering", description: "Front porch fixture flickers; new bulb did not fix it.", category: "Electrical", priority: "low", status: "completed", property: aggieland, submittedBy: "luke.tran@spo.org" },
    { title: "Basement smells musty after rain", description: "Noticeable after last week's storms; no standing water visible.", category: "Structural", priority: "medium", status: "pending", property: como, submittedBy: "sam.oconnor@spo.org" },
    { title: "Garbage disposal jammed", description: "Hums but doesn't spin. Already tried the reset button.", category: "Appliance", priority: "medium", status: "completed", property: cleveland, submittedBy: "joe.miller@spo.org" },
    { title: "Add a second towel bar in shared bath", description: "Six guys, one towel bar. Not urgent, would be great to have.", category: "Other", priority: "wishlist", status: "pending", property: como, submittedBy: "sam.oconnor@spo.org" },
    { title: "Smoke detector chirping", description: "Hallway detector chirps every minute; battery replaced, still chirping.", category: "Safety Equipment", priority: "high", status: "cancelled", property: dinkytown, submittedBy: "clare.hughes@spo.org" },
    { title: "Water heater pilot keeps going out", description: "Relit three times this week; goes out again within a day.", category: "Plumbing", priority: "urgent", status: "pending", property: badger, submittedBy: "will.chen@spo.org" },
  ] as const;

  const requests = [];
  for (const row of requestRows) {
    const photoUrl =
      row.priority === "urgent" ? await seedImage(`request-${requests.length + 1}.png`) : null;
    requests.push(
      await storage.createMaintenanceRequest({
        title: row.title,
        description: row.description,
        category: row.category,
        priority: row.priority,
        status: row.status,
        location: row.property.name,
        region: row.property.region,
        buildingAddress: row.property.address,
        submittedBy: row.submittedBy,
        photoUrl,
      }),
    );
  }
  console.log(`Seeded ${requests.length} maintenance requests`);

  // Link the plumbing and HVAC vendors to the requests they'd be called for.
  await storage.linkContactToRequest(requests[0].id, contacts[0].id);
  await storage.linkContactToRequest(requests[1].id, contacts[1].id);
  await storage.linkContactToRequest(requests[9].id, contacts[0].id);
  console.log("Linked 3 vendor contacts to requests");

  // ── Walkthrough rooms and photos ──────────────────────────────────────────
  const roomRows = [
    { name: "Kitchen", property: cleveland, displayOrder: 1, requiredQuestions: ["Are all appliances working?", "Any leaks under the sink?"] },
    { name: "Living Room", property: cleveland, displayOrder: 2, requiredQuestions: ["Condition of walls and floors?"] },
    { name: "Kitchen", property: como, displayOrder: 1, requiredQuestions: ["Are all appliances working?"] },
    { name: "Basement", property: como, displayOrder: 2, requiredQuestions: ["Any signs of moisture?", "Is the furnace area clear?"] },
  ];
  const rooms = [];
  for (const row of roomRows) {
    rooms.push(
      await storage.createWalkthroughRoom({
        name: row.name,
        propertyId: row.property.id,
        buildingAddress: row.property.address,
        displayOrder: row.displayOrder,
        requiredQuestions: row.requiredQuestions,
      }),
    );
  }
  for (const [i, room] of rooms.entries()) {
    await storage.createWalkthroughPhoto({
      roomId: room.id,
      imageUrl: await seedImage(`walkthrough-${room.name.toLowerCase().replace(/\s+/g, "-")}-${i}.png`),
      condition: i === 3 ? "additional_damage" : "same_as_last_walkthrough",
      notes: i === 3 ? "Water staining on the north wall since last visit." : null,
      region: roomRows[i].property.region,
      buildingAddress: room.buildingAddress,
      location: room.name,
      uploadedBy: "seed-script",
    });
  }
  console.log(`Seeded ${rooms.length} walkthrough rooms with a photo each`);

  // ── Assets ────────────────────────────────────────────────────────────────
  const assetRows = [
    { name: "Whirlpool Refrigerator", category: "Appliance", type: "fixed", ageInYears: 3, serialNumber: "WRF535SWHZ-0417", purchasePrice: "1249.00", assetTagId: "SPO-A-0001", property: cleveland, location: "Kitchen", lastServiced: daysAgo(200) },
    { name: "Carrier Furnace", category: "HVAC", type: "fixed", ageInYears: 9, serialNumber: "59TP6B-2201", purchasePrice: "3400.00", assetTagId: "SPO-A-0002", property: como, location: "Basement", lastServiced: daysAgo(90) },
    { name: "LG Washer", category: "Appliance", type: "fixed", ageInYears: 2, serialNumber: "WM3400CW-8812", purchasePrice: "749.00", assetTagId: "SPO-A-0003", property: dinkytown, location: "Laundry Room", lastServiced: null },
    { name: "Folding Tables (set of 4)", category: "Furniture", type: "movable", ageInYears: 1, serialNumber: null, purchasePrice: "320.00", assetTagId: "SPO-A-0004", property: franciscan, location: "Common Room", lastServiced: null },
    { name: "Snow Blower", category: "Vehicle", type: "movable", ageInYears: 5, serialNumber: "TORO-721E-3341", purchasePrice: "899.00", assetTagId: "SPO-A-0005", property: aggieland, location: "Garage", lastServiced: daysAgo(365) },
  ];
  const assets = [];
  for (const row of assetRows) {
    assets.push(
      await storage.createAsset({
        name: row.name,
        category: row.category,
        type: row.type as "fixed" | "movable",
        ageInYears: row.ageInYears,
        lastServiced: row.lastServiced,
        serialNumber: row.serialNumber,
        purchasePrice: row.purchasePrice,
        assetTagId: row.assetTagId,
        propertyId: row.property.id,
        location: row.location,
        region: row.property.region,
        buildingAddress: row.property.address,
      }),
    );
  }
  for (const asset of assets.slice(0, 2)) {
    await storage.createAssetPhoto({
      assetId: asset.id,
      imageUrl: await seedImage(`asset-${asset.assetTagId}.png`),
      caption: `${asset.name} — condition photo`,
      uploadedBy: "seed-script",
    });
  }
  console.log(`Seeded ${assets.length} assets (2 with photos)`);

  // ── Invoices ──────────────────────────────────────────────────────────────
  const invoiceRows = [
    { invoiceNumber: "INV-2026-041", contact: contacts[0], request: requests[0], service: "Plumbing", amount: "285.00", status: "pending", dueDate: daysAhead(21), paidDate: null },
    { invoiceNumber: "INV-2026-038", contact: contacts[1], request: requests[1], service: "HVAC", amount: "540.00", status: "pending", dueDate: daysAhead(14), paidDate: null },
    { invoiceNumber: "INV-2026-029", contact: contacts[2], request: null, service: "Electrical", amount: "175.00", status: "paid", dueDate: daysAgo(10), paidDate: daysAgo(12) },
    { invoiceNumber: "INV-2026-022", contact: contacts[4], request: null, service: "Roofing inspection", amount: "450.00", status: "overdue", dueDate: daysAgo(30), paidDate: null },
  ];
  for (const row of invoiceRows) {
    await storage.createInvoice({
      invoiceNumber: row.invoiceNumber,
      contactId: row.contact.id,
      maintenanceRequestId: row.request?.id ?? null,
      service: row.service,
      amount: row.amount,
      status: row.status as "pending" | "paid" | "overdue",
      dueDate: row.dueDate,
      paidDate: row.paidDate,
      region: row.contact.region,
      buildingAddress: row.contact.buildingAddress,
    });
  }
  console.log(`Seeded ${invoiceRows.length} invoices`);

  // ── Billing records (vendor onboarding docs) ──────────────────────────────
  for (const contact of contacts.slice(0, 3)) {
    await storage.createBillingRecord({
      contactId: contact.id,
      companyName: contact.company,
      email: contact.email,
      phone: contact.phone,
      invoiceCost: "0.00",
      contractInvoiceUrl: await seedImage(`contract-${contact.company.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`),
      coiUrl: null,
      w9Url: null,
      region: contact.region,
    });
  }
  console.log("Seeded 3 billing records");

  // ── Preventive & safety schedules ─────────────────────────────────────────
  // A realistic mix of overdue / due-soon / up-to-date across the first houses.
  const daysFromNow = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);
  const scheduleRows: Array<{
    property: (typeof properties)[number];
    title: string;
    category: "safety" | "preventive";
    intervalMonths: number;
    dueInDays: number;
    lastDoneDaysAgo?: number;
  }> = [
    { property: properties[0], title: "Smoke & CO detector test", category: "safety", intervalMonths: 6, dueInDays: -12, lastDoneDaysAgo: 195 },
    { property: properties[0], title: "Fire extinguisher check", category: "safety", intervalMonths: 12, dueInDays: 21, lastDoneDaysAgo: 344 },
    { property: properties[0], title: "Furnace / heating service", category: "preventive", intervalMonths: 12, dueInDays: 190, lastDoneDaysAgo: 175 },
    { property: properties[1], title: "Dryer vent cleaning", category: "safety", intervalMonths: 12, dueInDays: -40, lastDoneDaysAgo: 405 },
    { property: properties[1], title: "HVAC filter change", category: "preventive", intervalMonths: 3, dueInDays: 8, lastDoneDaysAgo: 82 },
    { property: properties[2], title: "Fire extinguisher check", category: "safety", intervalMonths: 12, dueInDays: 250, lastDoneDaysAgo: 115 },
    { property: properties[2], title: "Gutter cleaning", category: "preventive", intervalMonths: 12, dueInDays: 30 },
  ];
  for (const row of scheduleRows) {
    await storage.createMaintenanceSchedule({
      propertyId: row.property.id,
      title: row.title,
      category: row.category,
      intervalMonths: row.intervalMonths,
      nextDueDate: daysFromNow(row.dueInDays),
      lastCompletedDate: row.lastDoneDaysAgo ? daysFromNow(-row.lastDoneDaysAgo) : null,
      region: row.property.region,
      buildingAddress: row.property.address,
    });
  }
  console.log(`Seeded ${scheduleRows.length} maintenance schedules`);

  // ── Optional pre-created admin ────────────────────────────────────────────
  const adminEmail = process.env.SEED_ADMIN_EMAIL?.trim();
  if (adminEmail) {
    const admin = await storage.upsertUser({
      id: "seed-admin",
      email: adminEmail,
      firstName: "Pre-created",
      lastName: "Admin",
    });
    await storage.updateUserRole(admin.id, "admin");
    console.log(
      `Pre-created admin account for ${adminEmail} — the first Google sign-in with that address arrives as an admin.`,
    );
  } else {
    console.log(
      "No SEED_ADMIN_EMAIL set — the first sign-in will be a resident (promote with SQL, see README).",
    );
  }

  console.log("Done.");
}

seed()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
