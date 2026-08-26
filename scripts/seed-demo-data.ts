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
  // Region + chapter pairs come from the official SPO Regions map (see
  // shared/regions.ts). Each chapter belongs to its property's region.
  const propertyRows = [
    { name: "Cleveland House", streetAddress: "1472 Cleveland Ave N", city: "St Paul", state: "MN", zipCode: "55108", region: "Northwest", chapter: "University of St. Thomas", propertyManager: "Sarah Jenkins", bedrooms: 5, bathrooms: "2.0", squareFootage: 2400 },
    { name: "Como Men's House", streetAddress: "981 Como Ave", city: "St Paul", state: "MN", zipCode: "55103", region: "Northwest", chapter: "University of Minnesota", propertyManager: "Sarah Jenkins", bedrooms: 6, bathrooms: "2.5", squareFootage: 2800 },
    { name: "Dinkytown Women's House", streetAddress: "615 8th Ave SE", city: "Minneapolis", state: "MN", zipCode: "55414", region: "Northwest", chapter: "Twin Cities Young Adults", propertyManager: "Mark Otto", bedrooms: 4, bathrooms: "2.0", squareFootage: 1900 },
    { name: "Buckeye House", streetAddress: "210 University Blvd", city: "Columbus", state: "OH", zipCode: "43210", region: "East Central", chapter: "Ohio State University", propertyManager: "Angela Ruiz", bedrooms: 7, bathrooms: "3.0", squareFootage: 3200 },
    { name: "Aggieland House", streetAddress: "504 College Main St", city: "College Station", state: "TX", zipCode: "77840", region: "Southwest", chapter: "Bryan College Station Young Adults", propertyManager: "Mark Otto", bedrooms: 5, bathrooms: "2.0", squareFootage: 2200 },
    { name: "Jayhawk House", streetAddress: "1301 Massachusetts St", city: "Lawrence", state: "KS", zipCode: "66044", region: "West Central", chapter: "University of Kansas", propertyManager: null, bedrooms: 6, bathrooms: "2.5", squareFootage: 2600 },
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
  const [cleveland, como, dinkytown, buckeye, aggieland, jayhawk] = properties;
  console.log(`Seeded ${properties.length} properties`);

  // ── Vendor contacts ───────────────────────────────────────────────────────
  const contactRows = [
    { name: "Tom Blake", company: "Blake Plumbing LLC", service: "Plumbing", phone: "651-555-0142", email: "office@blakeplumbing.com", region: cleveland.region, buildingAddress: cleveland.address },
    { name: "Rita Moreno", company: "TwinCities HVAC", service: "HVAC", phone: "612-555-0177", email: "dispatch@tchvac.com", region: como.region, buildingAddress: como.address },
    { name: "Dave Kowalski", company: "Kowalski Electric", service: "Electrical", phone: "608-555-0101", email: "dave@kowalskielectric.com", region: dinkytown.region, buildingAddress: dinkytown.address },
    { name: "Maria Santos", company: "Santos Appliance Repair", service: "Appliance", phone: "979-555-0166", email: "maria@santosrepair.com", region: aggieland.region, buildingAddress: aggieland.address },
    { name: "Ed Harmon", company: "Harmon Roofing & Gutters", service: "Structural", phone: "740-555-0133", email: "ed@harmonroofing.com", region: buckeye.region, buildingAddress: buckeye.address },
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
    { title: "Dryer not heating", description: "Runs a full cycle but clothes come out cold and damp.", category: "Appliance", priority: "high", status: "in_progress", property: buckeye, submittedBy: "ben.walsh@spo.org" },
    { title: "Porch light flickering", description: "Front porch fixture flickers; new bulb did not fix it.", category: "Electrical", priority: "low", status: "completed", property: aggieland, submittedBy: "luke.tran@spo.org" },
    { title: "Basement smells musty after rain", description: "Noticeable after last week's storms; no standing water visible.", category: "Structural", priority: "medium", status: "pending", property: como, submittedBy: "sam.oconnor@spo.org" },
    { title: "Garbage disposal jammed", description: "Hums but doesn't spin. Already tried the reset button.", category: "Appliance", priority: "medium", status: "completed", property: cleveland, submittedBy: "joe.miller@spo.org" },
    { title: "Add a second towel bar in shared bath", description: "Six guys, one towel bar. Not urgent, would be great to have.", category: "Other", priority: "wishlist", status: "pending", property: como, submittedBy: "sam.oconnor@spo.org" },
    { title: "Smoke detector chirping", description: "Hallway detector chirps every minute; battery replaced, still chirping.", category: "Safety Equipment", priority: "high", status: "cancelled", property: dinkytown, submittedBy: "clare.hughes@spo.org" },
    { title: "Water heater pilot keeps going out", description: "Relit three times this week; goes out again within a day.", category: "Plumbing", priority: "urgent", status: "pending", property: jayhawk, submittedBy: "will.chen@spo.org" },
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
    { name: "Folding Tables (set of 4)", category: "Furniture", type: "movable", ageInYears: 1, serialNumber: null, purchasePrice: "320.00", assetTagId: "SPO-A-0004", property: buckeye, location: "Common Room", lastServiced: null },
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

  // ── Residents ─────────────────────────────────────────────────────────────
  // A handful of current residents per house, plus one who has moved out, so
  // the Current / Former tabs both show something.
  const residentRows: Array<{
    property: (typeof properties)[number];
    firstName: string;
    lastName: string;
    email: string;
    movedInDaysAgo: number;
    movedOutDaysAgo?: number;
  }> = [
    { property: properties[0], firstName: "Michael", lastName: "Fisher", email: "michael.fisher@spo.org", movedInDaysAgo: 320 },
    { property: properties[0], firstName: "Daniel", lastName: "Nguyen", email: "daniel.nguyen@spo.org", movedInDaysAgo: 320 },
    { property: properties[0], firstName: "Peter", lastName: "Okafor", email: "peter.okafor@spo.org", movedInDaysAgo: 55 },
    { property: properties[1], firstName: "Rachel", lastName: "Bauer", email: "rachel.bauer@spo.org", movedInDaysAgo: 300 },
    { property: properties[1], firstName: "Sofia", lastName: "Marchetti", email: "sofia.marchetti@spo.org", movedInDaysAgo: 300 },
    { property: properties[2], firstName: "Grace", lastName: "Sullivan", email: "grace.sullivan@spo.org", movedInDaysAgo: 60 },
    { property: properties[0], firstName: "Thomas", lastName: "Reilly", email: "thomas.reilly@spo.org", movedInDaysAgo: 700, movedOutDaysAgo: 40 },
    { property: properties[1], firstName: "Anna", lastName: "Kowalski", email: "anna.kowalski@spo.org", movedInDaysAgo: 500, movedOutDaysAgo: 18 },
  ];
  const residents = [];
  for (const row of residentRows) {
    residents.push(
      await storage.createResident({
        propertyId: row.property.id,
        firstName: row.firstName,
        lastName: row.lastName,
        email: row.email,
        moveInDate: daysFromNow(-row.movedInDaysAgo),
        moveOutDate: row.movedOutDaysAgo ? daysFromNow(-row.movedOutDaysAgo) : null,
        isActive: row.movedOutDaysAgo === undefined,
        region: row.property.region,
        buildingAddress: row.property.address,
      }),
    );
  }
  console.log(`Seeded ${residentRows.length} residents`);

  // ── Resident finances: rent + deposits ─────────────────────────────────────
  // A flat house rent for the current month, with a realistic paid/unpaid mix,
  // and a deposit per current resident (one already returned).
  const period = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  })();
  const rentByProperty = new Map<string, number>([
    [properties[0].id, 550],
    [properties[1].id, 600],
    [properties[2].id, 525],
  ]);
  let rentCount = 0;
  for (const [i, resident] of residents.entries()) {
    if (!resident.isActive) continue;
    const amount = rentByProperty.get(resident.propertyId);
    if (amount === undefined) continue;
    const paid = i % 3 !== 0; // roughly two-thirds paid
    await storage.createRentPayment({
      residentId: resident.id,
      propertyId: resident.propertyId,
      period,
      amount: String(amount),
      status: paid ? "paid" : "unpaid",
      paidDate: paid ? daysFromNow(-2) : null,
      reference: paid ? "check" : null,
      region: resident.region,
      buildingAddress: resident.buildingAddress,
    });
    rentCount += 1;
  }
  console.log(`Seeded ${rentCount} rent payments for ${period}`);

  let depositCount = 0;
  for (const [i, resident] of residents.entries()) {
    // A resident who left a while ago has been settled up; one who left recently
    // is still owed their deposit, so it stays "held" and shows on the dashboard
    // as a "deposit to return" action item.
    const movedOutDaysAgo = residentRows[i].movedOutDaysAgo ?? 0;
    const returned = !resident.isActive && movedOutDaysAgo > 30;
    await storage.createSecurityDeposit({
      residentId: resident.id,
      propertyId: resident.propertyId,
      amountHeld: String(500 + (i % 2) * 50),
      status: returned ? "partially_returned" : "held",
      amountReturned: returned ? "425" : null,
      returnedDate: returned ? daysFromNow(-38) : null,
      deductionsNotes: returned ? "$75 held back for a wall repair in the shared bathroom." : null,
      region: resident.region,
      buildingAddress: resident.buildingAddress,
    });
    depositCount += 1;
  }
  console.log(`Seeded ${depositCount} security deposits`);

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

    // A couple of manual tasks so the Tasks page and dashboard show both derived
    // and hand-written items. Tasks need an owner (createdBy), so they are only
    // seeded when there is a seeded admin to own them.
    await storage.createTask({
      title: "Replace furnace filters before winter",
      notes: "Coordinate with the RA to get all Northwest houses done in one weekend.",
      category: "property",
      dueDate: daysFromNow(21),
      region: properties[0].region,
      assignedToUserId: null,
      createdBy: admin.id,
    });
    await storage.createTask({
      title: "Call the bank about the deposit account",
      notes: null,
      category: "finance",
      dueDate: null,
      region: null,
      assignedToUserId: admin.id,
      createdBy: admin.id,
    });
    console.log("Seeded 2 tasks");
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
