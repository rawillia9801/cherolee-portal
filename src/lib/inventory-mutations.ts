import type { InventoryItem } from "./types";

export type InventoryDirection = "add" | "remove";

export function calculateInventoryAdjustment(input: {
  item: Pick<InventoryItem, "quantity_on_hand" | "unit_cost" | "needs_cost" | "supplier">;
  quantity: number;
  direction: InventoryDirection;
  reason?: string;
  unitCost?: number;
  supplier?: string;
}) {
  const quantity = Math.max(1, Math.round(input.quantity || 1));
  if (input.direction === "remove" && !input.reason) {
    throw new Error("Please select a removal reason.");
  }

  const currentQuantity = Number(input.item.quantity_on_hand || 0);
  const quantityChange = input.direction === "add" ? quantity : -quantity;
  const nextQuantity = currentQuantity + quantityChange;
  if (nextQuantity < 0) throw new Error("Inventory cannot go below zero.");

  const unitCost =
    input.direction === "add" && input.unitCost !== undefined && input.unitCost >= 0
      ? input.unitCost
      : Number(input.item.unit_cost || 0);

  return {
    quantity,
    quantityChange,
    nextQuantity,
    unitCost,
    supplier: input.supplier?.trim() || input.item.supplier || null,
    needsCost: !Number(unitCost),
  };
}
