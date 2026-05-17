import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { InventoryItem, OrderView, ParsedImport } from "./types";

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

export function isSupabaseConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

export function getSupabaseClient() {
  if (!isSupabaseConfigured()) return null;
  if (!client) {
    client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
  }
  return client;
}

export async function loadDashboardData() {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase is not configured.");

  const [ordersResponse, inventoryResponse] = await Promise.all([
    supabase
      .from("orders")
      .select("*, items:order_items(*), fees:order_fees(*), shipments(*), transactions(*)")
      .order("order_date", { ascending: false }),
    supabase.from("inventory_items").select("*").order("product_name", { ascending: true }),
  ]);

  if (ordersResponse.error) throw ordersResponse.error;
  if (inventoryResponse.error) throw inventoryResponse.error;

  return {
    orders: (ordersResponse.data ?? []) as OrderView[],
    inventory: (inventoryResponse.data ?? []) as InventoryItem[],
  };
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
    needs_cost: !Number(existingInventory?.unit_cost),
    quantity_on_hand: existingInventory?.quantity_on_hand ?? 0,
    unit_cost: existingInventory?.unit_cost ?? 0,
    reorder_point: existingInventory?.reorder_point ?? 0,
    sku: existingInventory?.sku ?? null,
    supplier: existingInventory?.supplier ?? null,
    notes: existingInventory?.notes ?? null,
  };

  const inventoryResponse = await supabase
    .from("inventory_items")
    .upsert(inventoryPayload, { onConflict: "upc", ignoreDuplicates: false })
    .select("*")
    .single();

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
  ]);
  if (importInsert.error) throw formatSupabaseError("Recording import log", importInsert.error);

  const quantityDelta = order.quantity - previousQuantity;
  if (!wasExistingOrder || quantityDelta !== 0) {
    const quantityUpdate = await supabase
      .from("inventory_items")
      .update({
        quantity_on_hand: Math.max(0, Number(inventoryItem.quantity_on_hand || 0) - quantityDelta),
        needs_cost: !Number(inventoryItem.unit_cost),
      })
      .eq("id", inventoryItem.id);
    if (quantityUpdate.error) throw formatSupabaseError("Deducting inventory quantity", quantityUpdate.error);
  }

  return savedOrder.id as string;
}

export async function updateInventoryItem(id: string, patch: Partial<InventoryItem>) {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase is not configured.");
  const nextPatch = {
    ...patch,
    needs_cost: patch.unit_cost !== undefined ? !Number(patch.unit_cost) : patch.needs_cost,
  };
  const response = await supabase.from("inventory_items").update(nextPatch).eq("id", id);
  if (response.error) throw formatSupabaseError("Updating inventory item", response.error);
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

async function setInventoryQuantity(supabase: SupabaseClient, inventoryId: string, quantity: number, action: string) {
  const response = await supabase
    .from("inventory_items")
    .update({ quantity_on_hand: Math.max(0, Math.round(quantity)) })
    .eq("id", inventoryId);
  if (response.error) throw formatSupabaseError(action, response.error);
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
    await setInventoryQuantity(supabase, oldInventory.data.id, nextQuantity, "Adjusting inventory for edited quantity");
  } else {
    if (oldInventory?.data) {
      await setInventoryQuantity(
        supabase,
        oldInventory.data.id,
        Number(oldInventory.data.quantity_on_hand || 0) + oldQuantity,
        "Restoring old inventory item after UPC edit",
      );
    }
    await setInventoryQuantity(
      supabase,
      newInventory.id,
      Number(newInventory.quantity_on_hand || 0) - newQuantity,
      "Deducting new inventory item after UPC edit",
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
      );
    }
  }

  const deleteResponse = await supabase.from("orders").delete().eq("id", order.id);
  if (deleteResponse.error) throw formatSupabaseError("Deleting order", deleteResponse.error);
}
