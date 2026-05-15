import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { InventoryItem, OrderView, ParsedImport } from "./types";

let client: SupabaseClient | null = null;

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

  const existingOrderResponse = await supabase
    .from("orders")
    .select("id, order_items(upc, quantity)")
    .eq("po_number", poNumber)
    .maybeSingle();

  if (existingOrderResponse.error) throw existingOrderResponse.error;
  const wasExistingOrder = Boolean(existingOrderResponse.data?.id);
  const previousQuantity =
    existingOrderResponse.data?.order_items?.find((item: { upc?: string | null; quantity?: number }) => item.upc === upc)
      ?.quantity ?? 0;

  const existingInventoryResponse = await supabase.from("inventory_items").select("*").eq("upc", upc).maybeSingle();
  if (existingInventoryResponse.error) throw existingInventoryResponse.error;

  const inventoryPayload = {
    upc,
    product_name: order.product_name,
    marketplace: "Walmart",
    walmart_item_id: order.walmart_item_id || transactions.find((transaction) => transaction.item_id)?.item_id || null,
    needs_cost: !Number(existingInventoryResponse.data?.unit_cost),
    quantity_on_hand: existingInventoryResponse.data?.quantity_on_hand ?? 0,
    unit_cost: existingInventoryResponse.data?.unit_cost ?? 0,
    reorder_point: existingInventoryResponse.data?.reorder_point ?? 0,
  };

  const inventoryResponse = await supabase
    .from("inventory_items")
    .upsert(inventoryPayload, { onConflict: "upc", ignoreDuplicates: false })
    .select("*")
    .single();

  if (inventoryResponse.error) throw inventoryResponse.error;
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
        taxes: order.taxes,
        customer_total: order.customer_total,
        amount_adjusted: order.amount_adjusted,
      },
      { onConflict: "po_number" },
    )
    .select("*")
    .single();

  if (orderResponse.error) throw orderResponse.error;
  const savedOrder = orderResponse.data;

  await Promise.all([
    supabase.from("order_items").delete().eq("order_id", savedOrder.id),
    supabase.from("order_fees").delete().eq("order_id", savedOrder.id),
    supabase.from("shipments").delete().eq("order_id", savedOrder.id),
    supabase.from("transactions").delete().eq("order_id", savedOrder.id),
  ]);

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

  if (itemInsert.error) throw itemInsert.error;

  const feeRows = transactions
    .filter((transaction) => /fee|service|referral|processing/i.test(transaction.transaction_type))
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
    if (feeInsert.error) throw feeInsert.error;
  }

  const shipmentInsert = await supabase.from("shipments").insert({
    order_id: savedOrder.id,
    carrier: order.carrier || null,
    tracking_number: order.tracking_number || null,
    shipping_status: order.shipping_status || order.status || null,
    method: null,
    shipping_cost: order.shipping_cost,
    estimated_delivery: order.estimated_delivery || null,
    label_format: null,
  });
  if (shipmentInsert.error) throw shipmentInsert.error;

  if (transactions.length) {
    const txInsert = await supabase.from("transactions").insert(
      transactions.map((transaction) => ({
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
    if (txInsert.error) throw txInsert.error;
  }

  const importInsert = await supabase.from("imports").insert([
    {
      import_type: "walmart_order",
      raw_text: [parsed.raw_order_text, parsed.raw_transaction_text].filter(Boolean).join("\n\n--- transactions ---\n\n"),
      parsed_json: parsed,
    },
  ]);
  if (importInsert.error) throw importInsert.error;

  const quantityDelta = order.quantity - previousQuantity;
  if (!wasExistingOrder || quantityDelta !== 0) {
    const quantityUpdate = await supabase
      .from("inventory_items")
      .update({
        quantity_on_hand: Math.max(0, Number(inventoryItem.quantity_on_hand || 0) - quantityDelta),
        needs_cost: !Number(inventoryItem.unit_cost),
      })
      .eq("id", inventoryItem.id);
    if (quantityUpdate.error) throw quantityUpdate.error;
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
  if (response.error) throw response.error;
}
