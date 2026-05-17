import { getSupabaseClient } from "@/lib/supabase";

export async function DELETE() {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 500 });

    const ordersResponse = await supabase
      .from("orders")
      .select("id, po_number, walmart_order_number, items:order_items(id, inventory_item_id, quantity)");
    if (ordersResponse.error) throw ordersResponse.error;

    const orders = ordersResponse.data ?? [];
    for (const order of orders) {
      for (const item of order.items ?? []) {
        if (!item.inventory_item_id || !Number(item.quantity || 0)) continue;
        const inventoryResponse = await supabase
          .from("inventory_items")
          .select("id, quantity_on_hand")
          .eq("id", item.inventory_item_id)
          .maybeSingle();
        if (inventoryResponse.error) throw inventoryResponse.error;
        if (!inventoryResponse.data) continue;
        const quantityOnHand = Number(inventoryResponse.data.quantity_on_hand || 0);
        const quantity = Number(item.quantity || 0);
        const updateResponse = await supabase
          .from("inventory_items")
          .update({ quantity_on_hand: quantityOnHand + quantity })
          .eq("id", inventoryResponse.data.id);
        if (updateResponse.error) throw updateResponse.error;
      }
    }

    const orderIds = orders.map((order) => order.id);
    if (orderIds.length) {
      const movementDelete = await supabase.from("inventory_movements").delete().in("source_order_id", orderIds);
      if (movementDelete.error && !/inventory_movements|does not exist|schema cache/i.test(movementDelete.error.message ?? "")) {
        throw movementDelete.error;
      }
      const deleteResponse = await supabase.from("orders").delete().in("id", orderIds);
      if (deleteResponse.error) throw deleteResponse.error;
    }

    return Response.json({ ok: true, deleted: orders.length });
  } catch (error) {
    console.error("[api/orders/bulk DELETE] failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "Deleting all orders failed." }, { status: 500 });
  }
}
