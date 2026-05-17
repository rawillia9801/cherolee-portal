import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { calculateInventoryAdjustment } from "./inventory-mutations";
import type { DashboardData, InventoryItem, InventoryMovement, OrderView, ParsedImport } from "./types";

let client: SupabaseClient | null = null;

type SupabaseLikeError = {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
};

function formatSupabaseError(action: string, error: unknown) {
  const typed = error as SupabaseLikeError;
  const parts = [
    `${action} failed`,
    typed.code ? `code ${typed.code}` : "",
    typed.message,
    typed.details ? `Details: ${typed.details}` : "",
    typed.hint ? `Hint: ${typed.hint}` : "",
  ].filter(Boolean);
  return new Error(parts.join(". "));
}

function assertRequired(value: string, label: string) {
  if (!value.trim()) {
    throw new Error(`${label} is required before saving.`);
  }
}

function isSchemaCompatibilityError(error: SupabaseLikeError | null | undefined) {
  return Boolean(error && /schema cache|column|does not exist|inventory_movements|partner_item_id|partner_gtin|fulfillment_type|location|last_scanned_at|purchase_date|supplier/i.test(error.message ?? ""));
}

export function isSupabaseConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

export function getSupabaseClient() {
  if (!isSupabaseConfigured()) return null;
  if (!client) {
    client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false } },
    );
  }
  return client;
}

export async function loadDashboardData() {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase is not configured.");

  const [ordersResponse, inventoryResponse, movementsResponse] = await Promise.all([
    supabase
      .from("orders")
      .select("*, items:order_items(*), fees:order_fees(*), shipments(*), transactions(*)")
      .order("order_date", { ascending: false }),
    supabase.from("inventory_items").select("*").order("product_name", { ascending: true }),
    supabase.from("inventory_movements").select("*").order("created_at", { ascending: false }),
  ]);

  if (ordersResponse.error) throw ordersResponse.error;
  if (inventoryResponse.error) throw inventoryResponse.error;
  const missingMovementsTable = movementsResponse.error && /inventory_movements|does not exist|schema cache/i.test(movementsResponse.error.message ?? "");
  if (movementsResponse.error && !missingMovementsTable) throw movementsResponse.error;

  return {
    orders: (ordersResponse.data ?? []) as OrderView[],
    inventory: (inventoryResponse.data ?? []) as InventoryItem[],
    movements: (missingMovementsTable ? [] : movementsResponse.data ?? []) as InventoryMovement[],
  } satisfies DashboardData;
}

export async function saveParsedImport(parsed: ParsedImport) {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase is not configured.");

  const { order, transactions } = parsed;
  const poNumber = order.po_number.trim();
  const upc = order.upc.trim();
  assertRequired(poNumber, "PO number");
  assertRequired(upc, "UPC");
  if (!order.quantity || order.quantity < 1) throw new Error("Quantity must be at least 1 before saving.");
  if (!order.product_name.trim()) throw new Error("Product title is required before saving.");

  const existingOrderResponse = await supabase
    .from("orders")
    .select("id, order_items(upc, quantity)")
    .eq("po_number", poNumber)
    .maybeSingle();

  if (existingOrderResponse.error) throw formatSupabaseError("Checking duplicate order", existingOrderResponse.error);
  const wasExistingOrder = Boolean(existingOrderResponse.data?.id);
  const previousQuantity =
    existingOrderResponse.data?.order_items?.find((item: { upc?: string | null; quantity?: number }) => item.upc === upc)
      ?.quantity ?? 0;

  const existingInventoryResponse = await supabase.from("inventory_items").select("*").eq("upc", upc).maybeSingle();
  if (existingInventoryResponse.error) throw formatSupabaseError("Checking inventory item", existingInventoryResponse.error);
  const existingInventory = existingInventoryResponse.data as InventoryItem | null;

  const transactionIdentity = transactions.find((transaction) => transaction.item_id || transaction.upc || transaction.product_name);
  const transactionLocation = transactions.find((transaction) => transaction.location)?.location;
  const transactionFulfillment = transactions.find((transaction) => transaction.fulfillment_type)?.fulfillment_type;
  const inventoryPayload = {
    upc,
    product_name: order.product_name === "Unlabeled Walmart item" && existingInventory?.product_name
      ? existingInventory.product_name
      : order.product_name,
    marketplace: existingInventory?.marketplace || "Walmart",
    walmart_item_id:
      order.walmart_item_id ||
      transactions.find((transaction) => transaction.item_id)?.item_id ||
      existingInventory?.walmart_item_id ||
      null,
    partner_item_id: existingInventory?.partner_item_id || transactionIdentity?.item_id || null,
    partner_gtin: existingInventory?.partner_gtin || order.upc || null,
    fulfillment_type: existingInventory?.fulfillment_type || order.fulfillment_type || transactionFulfillment || "Seller Fulfilled",
    needs_cost: !Number(existingInventory?.unit_cost),
    quantity_on_hand: existingInventory?.quantity_on_hand ?? 0,
    unit_cost: existingInventory?.unit_cost ?? 0,
    reorder_point: existingInventory?.reorder_point ?? 0,
    sku: existingInventory?.sku ?? null,
    supplier: existingInventory?.supplier ?? null,
    location: existingInventory?.location || order.location || transactionLocation || null,
    notes: existingInventory?.notes ?? null,
  };

  let inventoryResponse = await supabase
    .from("inventory_items")
    .upsert(inventoryPayload, { onConflict: "upc", ignoreDuplicates: false })
    .select("*")
    .single();

  if (inventoryResponse.error && isSchemaCompatibilityError(inventoryResponse.error)) {
    inventoryResponse = await supabase
      .from("inventory_items")
      .upsert(
        {
          upc: inventoryPayload.upc,
          product_name: inventoryPayload.product_name,
          marketplace: inventoryPayload.marketplace,
          walmart_item_id: inventoryPayload.walmart_item_id,
          needs_cost: inventoryPayload.needs_cost,
          quantity_on_hand: inventoryPayload.quantity_on_hand,
          unit_cost: inventoryPayload.unit_cost,
          reorder_point: inventoryPayload.reorder_point,
          sku: inventoryPayload.sku,
          supplier: inventoryPayload.supplier,
          notes: inventoryPayload.notes,
        },
        { onConflict: "upc", ignoreDuplicates: false },
      )
      .select("*")
      .single();
  }
  if (inventoryResponse.error) throw formatSupabaseError("Upserting inventory item", inventoryResponse.error);
  const inventoryItem = inventoryResponse.data as InventoryItem;

  const orderResponse = await supabase
    .from("orders")
    .upsert(
      {
        po_number: poNumber,
        walmart_order_number: order.walmart_order_number || null,
        marketplace: "Walmart",
        order_date: order.order_date || null,
        ship_by: order.ship_by || null,
        deliver_by: order.deliver_by || null,
        customer_name: order.customer_name || null,
        status: order.status || order.shipping_status || "Parsed",
        subtotal: order.subtotal,
        shipping_fee_charged: order.shipping_fee_charged,
        taxes: 0,
        customer_total: order.subtotal,
        amount_adjusted: order.amount_adjusted,
      },
      { onConflict: "po_number" },
    )
    .select("*")
    .single();

  if (orderResponse.error) throw formatSupabaseError("Upserting order", orderResponse.error);
  const savedOrder = orderResponse.data;

  const cleanupResponses = await Promise.all([
    supabase.from("order_items").delete().eq("order_id", savedOrder.id),
    supabase.from("order_fees").delete().eq("order_id", savedOrder.id),
    supabase.from("shipments").delete().eq("order_id", savedOrder.id),
    supabase.from("transactions").delete().eq("order_id", savedOrder.id),
  ]);
  const cleanupError = cleanupResponses.find((response) => response.error)?.error;
  if (cleanupError) throw formatSupabaseError("Replacing existing order detail rows", cleanupError);

  const unitCost = Number(inventoryItem.unit_cost || 0);
  const itemInsert = await supabase.from("order_items").insert({
    order_id: savedOrder.id,
    inventory_item_id: inventoryItem.id,
    upc,
    product_name: order.product_name,
    walmart_item_id: order.walmart_item_id || inventoryItem.walmart_item_id || null,
    quantity: order.quantity,
    unit_price: order.unit_price,
    subtotal: order.subtotal,
    unit_cost: unitCost,
    total_cogs: Number((unitCost * order.quantity).toFixed(2)),
  });

  if (itemInsert.error) throw formatSupabaseError("Inserting order item", itemInsert.error);

  const matchingTransactions = transactions.filter((transaction) => {
    const transactionPo = transaction.po_number?.trim();
    return !transactionPo || transactionPo === poNumber || transactionPo === order.walmart_order_number;
  });
  const transactionShippingCost = matchingTransactions
    .filter((transaction) => /shipping label/i.test(transaction.transaction_type))
    .reduce((sum, transaction) => sum + Math.abs(Number(transaction.net_payable || 0)), 0);
  const feeRows = matchingTransactions
    .filter((transaction) => /fee|service|referral|processing|commission|reserve|wfs/i.test(transaction.transaction_type))
    .filter((transaction) => !/refund|shipping label/i.test(transaction.transaction_type))
    .map((transaction) => ({
      order_id: savedOrder.id,
      fee_type: transaction.transaction_type,
      amount: Math.abs(transaction.net_payable),
      source: "transaction",
      transaction_date: transaction.transaction_date || null,
      status: transaction.status || null,
    }));

  if (feeRows.length) {
    const feeInsert = await supabase.from("order_fees").insert(feeRows);
    if (feeInsert.error) throw formatSupabaseError("Inserting order fees", feeInsert.error);
  }

  const shipmentInsert = await supabase.from("shipments").insert({
    order_id: savedOrder.id,
    carrier: order.carrier || null,
    tracking_number: order.tracking_number || null,
    shipping_status: order.shipping_status || order.status || null,
    method: null,
    shipping_cost: transactionShippingCost || order.shipping_cost,
    estimated_delivery: order.estimated_delivery || null,
    label_format: null,
  });
  if (shipmentInsert.error) throw formatSupabaseError("Inserting shipment", shipmentInsert.error);

  if (matchingTransactions.length) {
    const txInsert = await supabase.from("transactions").insert(
      matchingTransactions.map((transaction) => ({
        order_id: savedOrder.id,
        po_number: poNumber,
        transaction_date: transaction.transaction_date || null,
        transaction_type: transaction.transaction_type,
        item_id: transaction.item_id || null,
        quantity: transaction.quantity,
        net_payable: transaction.net_payable,
        status: transaction.status || null,
        raw_text: transaction.raw_text,
      })),
    );
    if (txInsert.error) throw formatSupabaseError("Inserting transactions", txInsert.error);
  }

  const importInsert = await supabase.from("imports").insert([
    {
      import_type: "walmart_order",
      raw_text: [parsed.raw_order_text, parsed.raw_transaction_text].filter(Boolean).join("\n\n--- transactions ---\n\n"),
      parsed_json: parsed,
    },
  ]).select("id").single();
  if (importInsert.error) throw formatSupabaseError("Recording import log", importInsert.error);

  const quantityDelta = order.quantity - previousQuantity;
  const fulfillmentType = `${order.fulfillment_type || transactionFulfillment || inventoryItem.fulfillment_type || ""}`;
  const shouldDeductInventory = !/wfs|walmart-fulfilled/i.test(fulfillmentType);
  if (shouldDeductInventory && (!wasExistingOrder || quantityDelta !== 0)) {
    const quantityUpdate = await supabase
      .from("inventory_items")
      .update({
        quantity_on_hand: Math.max(0, Number(inventoryItem.quantity_on_hand || 0) - quantityDelta),
        needs_cost: !Number(inventoryItem.unit_cost),
      })
      .eq("id", inventoryItem.id);
    if (quantityUpdate.error) throw formatSupabaseError("Deducting inventory quantity", quantityUpdate.error);
    const movementPayload = {
      inventory_item_id: inventoryItem.id,
      movement_type: quantityDelta > 0 ? "sale_deduction" : "correction",
      quantity_change: -quantityDelta,
      reason: quantityDelta > 0 ? "Sale" : "Correction",
      source: "Settlement Import",
      source_order_id: savedOrder.id,
      source_order_number: order.walmart_order_number || null,
      source_po_number: poNumber,
      settlement_import_id: importInsert.data?.id ?? null,
      created_by: "System",
    };
    const movementInsert = await supabase.from("inventory_movements").insert(movementPayload);
    if (movementInsert.error && isSchemaCompatibilityError(movementInsert.error)) {
      const fallbackMovement = await supabase.from("inventory_movements").insert({
        inventory_item_id: movementPayload.inventory_item_id,
        movement_type: movementPayload.movement_type,
        quantity_change: movementPayload.quantity_change,
        reason: movementPayload.reason,
        source: movementPayload.source,
        created_by: movementPayload.created_by,
      });
      if (fallbackMovement.error && !isSchemaCompatibilityError(fallbackMovement.error)) {
        throw formatSupabaseError("Recording inventory movement", fallbackMovement.error);
      }
    } else if (movementInsert.error) {
      throw formatSupabaseError("Recording inventory movement", movementInsert.error);
    }
  }

  return savedOrder.id as string;
}

export async function updateInventoryItem(id: string, patch: Partial<InventoryItem>) {
  if (typeof window !== "undefined") {
    const response = await fetch("/api/inventory/item", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, patch }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Updating inventory item failed.");
    return payload.item as InventoryItem | undefined;
  }
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase is not configured.");
  const nextPatch = {
    ...patch,
    needs_cost: patch.unit_cost !== undefined ? !Number(patch.unit_cost) : patch.needs_cost,
  };
  const response = await supabase.from("inventory_items").update(nextPatch).eq("id", id);
  if (response.error) throw formatSupabaseError("Updating inventory item", response.error);
}

function normalizeLookup(value: string) {
  const trimmed = value.trim().replace(/[\s-]/g, "");
  if (!/[eE]\+/.test(trimmed)) return trimmed;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed.toLocaleString("en-US", { maximumFractionDigits: 0, useGrouping: false }) : trimmed;
}

export async function adjustInventoryQuantity(input: {
  item: InventoryItem;
  quantity: number;
  direction: "add" | "remove";
  reason?: "Gifted" | "Kept" | "Damaged" | "Other" | "Manual add" | "Added by scan";
  source?: string;
  scan?: boolean;
  unitCost?: number;
  supplier?: string;
  purchaseDate?: string;
}) {
  if (typeof window !== "undefined") {
    const response = await fetch("/api/inventory/adjust", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        itemId: input.item.id,
        quantity: input.quantity,
        direction: input.direction,
        reason: input.reason,
        source: input.source,
        scan: input.scan,
        unitCost: input.unitCost,
        supplier: input.supplier,
        purchaseDate: input.purchaseDate,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Inventory adjustment failed.");
    return payload.item as InventoryItem | undefined;
  }
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase is not configured.");

  const adjustment = calculateInventoryAdjustment({
    item: input.item,
    quantity: input.quantity,
    direction: input.direction,
    reason: input.reason,
    unitCost: input.unitCost,
    supplier: input.supplier,
  });

  const updateResponse = await supabase
    .from("inventory_items")
    .update({
      quantity_on_hand: adjustment.nextQuantity,
      unit_cost: adjustment.unitCost,
      supplier: adjustment.supplier,
      needs_cost: adjustment.needsCost,
      last_scanned_at: input.scan ? new Date().toISOString() : input.item.last_scanned_at ?? null,
    })
    .eq("id", input.item.id);
  if (updateResponse.error) throw formatSupabaseError("Updating inventory quantity", updateResponse.error);

  const movementPayload = {
    inventory_item_id: input.item.id,
    movement_type: input.direction === "add" ? (input.scan ? "scan_add" : "manual_add") : input.scan ? "scan_remove" : "manual_remove",
    quantity_change: adjustment.quantityChange,
    reason: input.direction === "add" ? input.reason || (input.scan ? "Added by scan" : "Manual add") : input.reason,
    source: input.source || (input.scan ? "Barcode Scan" : "Admin"),
    purchase_date: input.purchaseDate || null,
    supplier: input.supplier?.trim() || null,
    notes: input.direction === "add" && input.purchaseDate ? `Purchased ${input.purchaseDate}` : null,
    created_by: "Admin",
  };
  const movementResponse = await supabase.from("inventory_movements").insert(movementPayload);
  if (movementResponse.error && /inventory_movements|schema cache|purchase_date|supplier|column|does not exist/i.test(movementResponse.error.message ?? "")) {
    const fallbackResponse = await supabase.from("inventory_movements").insert({
      inventory_item_id: movementPayload.inventory_item_id,
      movement_type: movementPayload.movement_type,
      quantity_change: movementPayload.quantity_change,
      reason: movementPayload.reason,
      source: movementPayload.source,
      notes: [movementPayload.notes, input.supplier ? `Supplier: ${input.supplier}` : ""].filter(Boolean).join(" | ") || null,
      created_by: movementPayload.created_by,
    });
    if (fallbackResponse.error && !/inventory_movements|does not exist|schema cache/i.test(fallbackResponse.error.message ?? "")) {
      throw formatSupabaseError("Recording inventory movement", fallbackResponse.error);
    }
    return;
  }
  if (movementResponse.error) throw formatSupabaseError("Recording inventory movement", movementResponse.error);
}

export async function createInventoryItem(input: { upc: string; product_name?: string }) {
  if (typeof window !== "undefined") {
    const response = await fetch("/api/inventory/item", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Creating inventory item failed.");
    return payload.item as InventoryItem;
  }
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase is not configured.");
  const upc = normalizeLookup(input.upc);
  assertRequired(upc, "UPC");
  const basePayload = {
    upc,
    product_name: input.product_name?.trim() || `New item ${upc}`,
    marketplace: "Walmart",
    quantity_on_hand: 0,
    unit_cost: 0,
    reorder_point: 0,
    needs_cost: true,
  };

  const response = await supabase
    .from("inventory_items")
    .upsert(
      {
        ...basePayload,
        partner_gtin: upc,
        fulfillment_type: "Seller Fulfilled",
        last_scanned_at: new Date().toISOString(),
      },
      { onConflict: "upc" },
    )
    .select("*")
    .single();
  if (response.error && /schema cache|partner_gtin|fulfillment_type|last_scanned_at|column/i.test(response.error.message ?? "")) {
    const fallbackResponse = await supabase
      .from("inventory_items")
      .upsert(basePayload, { onConflict: "upc" })
      .select("*")
      .single();
    if (fallbackResponse.error) throw formatSupabaseError("Creating inventory item", fallbackResponse.error);
    return fallbackResponse.data as InventoryItem;
  }
  if (response.error) throw formatSupabaseError("Creating inventory item", response.error);
  return response.data as InventoryItem;
}

export type OrderEditInput = {
  po_number: string;
  walmart_order_number?: string | null;
  order_date?: string | null;
  customer_name?: string | null;
  status?: string | null;
  product_name: string;
  upc: string;
  walmart_item_id?: string | null;
  quantity: number;
  unit_price: number;
  subtotal: number;
  taxes: number;
  customer_total: number;
  shipping_cost: number;
  walmart_fee: number;
};

async function ensureInventoryItem(supabase: SupabaseClient, input: OrderEditInput) {
  const existingResponse = await supabase.from("inventory_items").select("*").eq("upc", input.upc).maybeSingle();
  if (existingResponse.error) throw formatSupabaseError("Checking edited order inventory", existingResponse.error);
  const existing = existingResponse.data as InventoryItem | null;

  const response = await supabase
    .from("inventory_items")
    .upsert(
      {
        upc: input.upc,
        product_name: existing?.product_name || input.product_name || "Unlabeled Walmart item",
        marketplace: existing?.marketplace || "Walmart",
        walmart_item_id: input.walmart_item_id || existing?.walmart_item_id || null,
        quantity_on_hand: existing?.quantity_on_hand ?? 0,
        unit_cost: existing?.unit_cost ?? 0,
        reorder_point: existing?.reorder_point ?? 0,
        needs_cost: !Number(existing?.unit_cost),
        sku: existing?.sku ?? null,
        supplier: existing?.supplier ?? null,
        notes: existing?.notes ?? null,
      },
      { onConflict: "upc" },
    )
    .select("*")
    .single();

  if (response.error) throw formatSupabaseError("Upserting edited order inventory", response.error);
  return response.data as InventoryItem;
}

async function setInventoryQuantity(
  supabase: SupabaseClient,
  inventoryId: string,
  quantity: number,
  action: string,
  movement?: Omit<InventoryMovement, "id" | "created_at" | "inventory_item_id">,
) {
  const response = await supabase
    .from("inventory_items")
    .update({ quantity_on_hand: Math.max(0, Math.round(quantity)) })
    .eq("id", inventoryId);
  if (response.error) throw formatSupabaseError(action, response.error);
  if (movement && movement.quantity_change) {
    const movementResponse = await supabase.from("inventory_movements").insert({
      ...movement,
      inventory_item_id: inventoryId,
    });
    if (movementResponse.error) throw formatSupabaseError("Recording inventory movement", movementResponse.error);
  }
}

export async function updateOrderRecord(order: OrderView, input: OrderEditInput) {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase is not configured.");

  assertRequired(input.po_number, "PO number");
  assertRequired(input.upc, "UPC");
  assertRequired(input.product_name, "Product title");
  if (!input.quantity || input.quantity < 1) throw new Error("Quantity must be at least 1 before saving.");

  const oldItem = order.items[0];
  const oldInventory = oldItem?.inventory_item_id
    ? await supabase.from("inventory_items").select("*").eq("id", oldItem.inventory_item_id).maybeSingle()
    : null;
  if (oldInventory?.error) throw formatSupabaseError("Loading current inventory before edit", oldInventory.error);

  const newInventory = await ensureInventoryItem(supabase, input);
  const oldQuantity = Number(oldItem?.quantity || 0);
  const oldUpc = oldItem?.upc || input.upc;
  const newQuantity = Number(input.quantity || 0);

  const orderResponse = await supabase
    .from("orders")
    .update({
      po_number: input.po_number.trim(),
      walmart_order_number: input.walmart_order_number || null,
      order_date: input.order_date || null,
      customer_name: input.customer_name || null,
      status: input.status || "Parsed",
      subtotal: input.subtotal,
      taxes: 0,
      customer_total: input.subtotal,
    })
    .eq("id", order.id);
  if (orderResponse.error) throw formatSupabaseError("Updating order", orderResponse.error);

  const cleanupResponses = await Promise.all([
    supabase.from("order_items").delete().eq("order_id", order.id),
    supabase.from("order_fees").delete().eq("order_id", order.id),
    supabase.from("shipments").delete().eq("order_id", order.id),
  ]);
  const cleanupError = cleanupResponses.find((response) => response.error)?.error;
  if (cleanupError) throw formatSupabaseError("Replacing edited order detail rows", cleanupError);

  const unitCost = Number(newInventory.unit_cost || 0);
  const itemResponse = await supabase.from("order_items").insert({
    order_id: order.id,
    inventory_item_id: newInventory.id,
    upc: input.upc,
    product_name: input.product_name,
    walmart_item_id: input.walmart_item_id || newInventory.walmart_item_id || null,
    quantity: newQuantity,
    unit_price: input.unit_price,
    subtotal: input.subtotal,
    unit_cost: unitCost,
    total_cogs: Number((unitCost * newQuantity).toFixed(2)),
  });
  if (itemResponse.error) throw formatSupabaseError("Updating order item", itemResponse.error);

  if (input.walmart_fee) {
    const feeResponse = await supabase.from("order_fees").insert({
      order_id: order.id,
      fee_type: "Walmart Service Fee",
      amount: Math.abs(input.walmart_fee),
      source: "manual edit",
      transaction_date: input.order_date || null,
      status: "Posted",
    });
    if (feeResponse.error) throw formatSupabaseError("Updating order fee", feeResponse.error);
  }

  const shipmentResponse = await supabase.from("shipments").insert({
    order_id: order.id,
    shipping_status: input.status || null,
    shipping_cost: input.shipping_cost,
  });
  if (shipmentResponse.error) throw formatSupabaseError("Updating shipment", shipmentResponse.error);

  if (oldUpc === input.upc && oldInventory?.data) {
    const nextQuantity = Number(oldInventory.data.quantity_on_hand || 0) + oldQuantity - newQuantity;
    await setInventoryQuantity(supabase, oldInventory.data.id, nextQuantity, "Adjusting inventory for edited quantity", {
      movement_type: "correction",
      quantity_change: oldQuantity - newQuantity,
      reason: "Correction",
      source: "Admin",
      source_order_id: order.id,
      source_order_number: input.walmart_order_number || null,
      source_po_number: input.po_number,
      created_by: "Admin",
    });
  } else {
    if (oldInventory?.data) {
      await setInventoryQuantity(
        supabase,
        oldInventory.data.id,
        Number(oldInventory.data.quantity_on_hand || 0) + oldQuantity,
        "Restoring old inventory item after UPC edit",
        {
          movement_type: "correction",
          quantity_change: oldQuantity,
          reason: "Correction",
          source: "Admin",
          source_order_id: order.id,
          source_order_number: order.walmart_order_number || null,
          source_po_number: order.po_number,
          created_by: "Admin",
        },
      );
    }
    await setInventoryQuantity(
      supabase,
      newInventory.id,
      Number(newInventory.quantity_on_hand || 0) - newQuantity,
      "Deducting new inventory item after UPC edit",
      {
        movement_type: "sale_deduction",
        quantity_change: -newQuantity,
        reason: "Sale",
        source: "Admin",
        source_order_id: order.id,
        source_order_number: input.walmart_order_number || null,
        source_po_number: input.po_number,
        created_by: "Admin",
      },
    );
  }
}

export async function deleteOrderRecord(order: OrderView) {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase is not configured.");

  for (const item of order.items) {
    if (!item.inventory_item_id) continue;
    const inventoryResponse = await supabase
      .from("inventory_items")
      .select("id, quantity_on_hand")
      .eq("id", item.inventory_item_id)
      .maybeSingle();
    if (inventoryResponse.error) throw formatSupabaseError("Loading inventory before order delete", inventoryResponse.error);
    if (inventoryResponse.data) {
      await setInventoryQuantity(
        supabase,
        inventoryResponse.data.id,
        Number(inventoryResponse.data.quantity_on_hand || 0) + Number(item.quantity || 0),
        "Restoring inventory after order delete",
        {
          movement_type: "correction",
          quantity_change: Number(item.quantity || 0),
          reason: "Correction",
          source: "Admin",
          source_order_id: order.id,
          source_order_number: order.walmart_order_number || null,
          source_po_number: order.po_number,
          created_by: "Admin",
        },
      );
    }
  }

  const deleteResponse = await supabase.from("orders").delete().eq("id", order.id);
  if (deleteResponse.error) throw formatSupabaseError("Deleting order", deleteResponse.error);
}

export async function deleteAllOrders() {
  if (typeof window !== "undefined") {
    const response = await fetch("/api/orders/bulk", { method: "DELETE" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Deleting all orders failed.");
    return Number(payload.deleted || 0);
  }
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase is not configured.");
  const ordersResponse = await supabase
    .from("orders")
    .select("*, items:order_items(*), fees:order_fees(*), shipments(*), transactions(*)");
  if (ordersResponse.error) throw formatSupabaseError("Loading orders before bulk delete", ordersResponse.error);
  for (const order of (ordersResponse.data ?? []) as OrderView[]) {
    await deleteOrderRecord(order);
  }
  return ordersResponse.data?.length ?? 0;
}
