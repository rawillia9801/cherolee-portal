import { createInventoryItem, getSupabaseClient, updateInventoryItem } from "@/lib/supabase";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const item = await createInventoryItem({
      upc: String(body.upc || ""),
      product_name: body.product_name ? String(body.product_name) : undefined,
    });
    return Response.json({ item });
  } catch (error) {
    console.error("[api/inventory/item POST] failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "Creating inventory item failed." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const id = String(body.id || "");
    if (!id) return Response.json({ error: "Inventory item id is required." }, { status: 400 });
    await updateInventoryItem(id, body.patch || {});
    const supabase = getSupabaseClient();
    if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 500 });
    const itemResponse = await supabase.from("inventory_items").select("*").eq("id", id).single();
    if (itemResponse.error) return Response.json({ error: itemResponse.error.message }, { status: 500 });
    return Response.json({ ok: true, item: itemResponse.data });
  } catch (error) {
    console.error("[api/inventory/item PATCH] failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "Updating inventory item failed." }, { status: 500 });
  }
}
