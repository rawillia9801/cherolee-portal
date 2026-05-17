import { adjustInventoryQuantity, getSupabaseClient } from "@/lib/supabase";
import type { InventoryItem } from "@/lib/types";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const itemId = String(body.itemId || "");
    if (!itemId) return Response.json({ error: "Inventory item id is required." }, { status: 400 });

    const supabase = getSupabaseClient();
    if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 500 });

    const itemResponse = await supabase.from("inventory_items").select("*").eq("id", itemId).maybeSingle();
    if (itemResponse.error) {
      console.error("[api/inventory/adjust] item lookup failed", itemResponse.error);
      return Response.json({ error: itemResponse.error.message }, { status: 500 });
    }
    if (!itemResponse.data) return Response.json({ error: "Inventory item was not found." }, { status: 404 });

    await adjustInventoryQuantity({
      item: itemResponse.data as InventoryItem,
      quantity: Number(body.quantity || 1),
      direction: body.direction === "remove" ? "remove" : "add",
      reason: body.reason,
      source: body.source,
      scan: Boolean(body.scan),
      unitCost: body.unitCost === undefined ? undefined : Number(body.unitCost),
      supplier: body.supplier,
      purchaseDate: body.purchaseDate,
    });

    const updatedResponse = await supabase.from("inventory_items").select("*").eq("id", itemId).single();
    if (updatedResponse.error) {
      console.error("[api/inventory/adjust] reload failed", updatedResponse.error);
      return Response.json({ error: updatedResponse.error.message }, { status: 500 });
    }

    return Response.json({ ok: true, item: updatedResponse.data });
  } catch (error) {
    console.error("[api/inventory/adjust] failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "Inventory adjustment failed." }, { status: 500 });
  }
}
