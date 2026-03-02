const MONDAY_API_URL = "https://api.monday.com/v2";

function getApiKey(): string {
  const raw = process.env.MONDAY_API_KEY || "";
  const half = Math.ceil(raw.length / 2);
  if (raw.length > 230 && raw.slice(0, half) === raw.slice(half)) {
    return raw.slice(0, half);
  }
  return raw;
}

const REGION_BOARD_MAP: Record<string, string> = {
  "West Central": "18398024843",
  "South West": "18398024773",
  "North West": "18398024703",
  "South East": "18398024539",
  "East Central": "18398024447",
  "North East": "18398024021",
};

const PRIORITY_COLUMN_MAP: Record<string, string> = {
  "West Central": "color_mm06qhsx",
  "South West": "color_mm06nxpp",
  "North West": "color_mm06a7cq",
  "South East": "color_mm069t5k",
  "East Central": "color_mm06yx4b",
  "North East": "color_mm063ccr",
};

const STATUS_TO_MONDAY: Record<string, number> = {
  pending: 0,
  in_progress: 1,
  completed: 2,
  cancelled: 3,
};

const PRIORITY_TO_MONDAY: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  urgent: 3,
  wishlist: 4,
};

async function mondayQuery(query: string, variables?: Record<string, unknown>) {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn("Monday.com: MONDAY_API_KEY not set, skipping.");
    return null;
  }

  const response = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await response.json() as any;
  if (data.errors) {
    console.error("Monday.com API error:", JSON.stringify(data.errors));
    return null;
  }
  return data.data;
}

export async function createMondayItem(request: {
  title: string;
  description: string;
  category: string;
  priority: string;
  status: string;
  region: string;
  buildingAddress: string;
  location: string;
  submittedBy: string;
}): Promise<string | null> {
  const boardId = REGION_BOARD_MAP[request.region];
  if (!boardId) {
    console.log(`Monday.com: No board mapped for region "${request.region}", skipping.`);
    return null;
  }

  const priorityColId = PRIORITY_COLUMN_MAP[request.region];
  const columnValues: Record<string, unknown> = {
    status: { index: STATUS_TO_MONDAY[request.status] ?? 0 },
  };
  if (priorityColId) {
    columnValues[priorityColId] = { index: PRIORITY_TO_MONDAY[request.priority] ?? 0 };
  }

  const itemName = `[${request.category}] ${request.title}`;

  const mutation = `
    mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) {
        id
      }
    }
  `;

  try {
    const result = await mondayQuery(mutation, {
      boardId,
      itemName,
      columnValues: JSON.stringify(columnValues),
    });
    const itemId = result?.create_item?.id ?? null;
    if (itemId) {
      console.log(`Monday.com: Created item ${itemId} on board ${boardId}`);
    }
    return itemId;
  } catch (err) {
    console.error("Monday.com: Failed to create item:", err);
    return null;
  }
}

export async function updateMondayItem(
  mondayItemId: string,
  region: string,
  updates: { status?: string; priority?: string }
): Promise<void> {
  const boardId = REGION_BOARD_MAP[region];
  if (!boardId || !mondayItemId) return;

  const priorityColId = PRIORITY_COLUMN_MAP[region];
  const mutations: string[] = [];
  const vars: Record<string, unknown> = {
    boardId,
    itemId: mondayItemId,
  };

  if (updates.status !== undefined) {
    mutations.push(`
      update_status: change_column_value(board_id: $boardId, item_id: $itemId, column_id: "status", value: $statusVal) { id }
    `);
    vars.statusVal = JSON.stringify({ index: STATUS_TO_MONDAY[updates.status] ?? 0 });
  }

  if (updates.priority !== undefined && priorityColId) {
    mutations.push(`
      update_priority: change_column_value(board_id: $boardId, item_id: $itemId, column_id: "${priorityColId}", value: $priorityVal) { id }
    `);
    vars.priorityVal = JSON.stringify({ index: PRIORITY_TO_MONDAY[updates.priority] ?? 0 });
  }

  if (mutations.length === 0) return;

  const varDefs = [
    "$boardId: ID!",
    "$itemId: ID!",
    updates.status !== undefined ? "$statusVal: JSON!" : null,
    updates.priority !== undefined && priorityColId ? "$priorityVal: JSON!" : null,
  ]
    .filter(Boolean)
    .join(", ");

  const mutation = `mutation (${varDefs}) { ${mutations.join("\n")} }`;

  try {
    await mondayQuery(mutation, vars);
    console.log(`Monday.com: Updated item ${mondayItemId}`);
  } catch (err) {
    console.error("Monday.com: Failed to update item:", err);
  }
}
