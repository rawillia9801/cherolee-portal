import assert from "node:assert/strict";
import { orderProfit } from "../src/lib/calculations";
import { calculateInventoryAdjustment } from "../src/lib/inventory-mutations";
import { parseWalmartImport } from "../src/lib/parser";
import type { InventoryItem, OrderView } from "../src/lib/types";

const header = [
  "Period Start Date",
  "Period End Date",
  "Total Payable",
  "Currency",
  "Transaction Key",
  "Transaction Posted Timestamp",
  "Transaction Type",
  "Transaction Description",
  "Customer Order #",
  "Customer Order line #",
  "Purchase Order #",
  "Purchase Order line #",
  "Amount",
  "Amount Type",
  "Ship Qty",
  "Commission Rate",
  "Base Commission Rate",
  "Transaction Reason Description",
  "Partner Item Id",
  "Partner GTIN",
  "Partner Item Name",
  "Product Tax Code",
  "Ship to State",
  "Ship to City",
  "Ship to Zipcode",
  "Contract Category",
  "Product Type",
  "Commission Rule",
  "Shipping Method",
  "Fulfillment Type",
  "Fulfillment Details",
  "Original Commission",
].join("\t");

const settlementRows = [
  ["", "", "", "", "2026_04_30_1387066", "4/29/2026", "Sale", "Purchase", "200014533145443", "1", "129112345678901", "1", "19.52", "Product Price", "1", "", "", "", "9100576668", "9100576668", "FRAM Ultra Air XGA12289 Premium Engine Air Filter", "2038710", "CA", "Temple City", "91780", "Automotive & Powersports", "Engine Air Filters", "BSE-47-18.0", "Marketplace standard", "Seller Fulfilled", "Delivery", ""],
  ["", "", "", "", "2026_04_30_1387066", "4/29/2026", "Sale", "Purchase", "200014533145443", "1", "129112345678901", "1", "-2.34", "Commission on Product", "1", "12", "12", "", "9100576668", "9100576668", "FRAM Ultra Air XGA12289 Premium Engine Air Filter", "2038710", "CA", "Temple City", "91780", "Automotive & Powersports", "Engine Air Filters", "BSE-47-18.0", "Marketplace standard", "Seller Fulfilled", "Delivery", "-2.34"],
  ["", "", "", "", "2026_04_30_1387065", "4/29/2026", "Adjustment", "Walmart Shipping Label Service Charge", "200014533145443", "1", "129112345678901", "1", "-8.23", "Fee/Reimbursement", "", "", "", "", "9100576668", "9100576668", "FRAM Ultra Air XGA12289 Premium Engine Air Filter", "2038710", "CA", "Temple City", "91780", "Automotive & Powersports", "Engine Air Filters", "", "", "Seller Fulfilled", "", ""],
  ["", "", "", "", "2026_04_24_859611", "4/23/2026", "Sale", "Purchase", "200014663509505", "1", "129111111111111", "1", "31.96", "Product Price", "4", "", "", "", "645397938446", "645397938446", "Skeeter Hawk Replacement Repellent for the Mosquito Wristband and Carabiner 2 Pack Blue", "3001194", "AZ", "PARADISE VALLEY", "85253", "Home & Garden", "Insect & Pest Repellent", "BSE-66-7.0", "Marketplace standard", "Seller Fulfilled", "Delivery", ""],
  ["", "", "", "", "2026_04_24_859611", "4/23/2026", "Sale", "Purchase", "200014663509505", "1", "129111111111111", "1", "-4.79", "Commission on Product", "4", "15", "15", "", "645397938446", "645397938446", "Skeeter Hawk Replacement Repellent for the Mosquito Wristband and Carabiner 2 Pack Blue", "3001194", "AZ", "PARADISE VALLEY", "85253", "Home & Garden", "Insect & Pest Repellent", "BSE-66-7.0", "Marketplace standard", "Seller Fulfilled", "Delivery", "-4.79"],
  ["", "", "", "", "2026_04_24_914033", "4/23/2026", "Adjustment", "Walmart Shipping Label Service Charge", "200014663509505", "1", "129111111111111", "1", "-3.82", "Fee/Reimbursement", "", "", "", "", "645397938446", "645397938446", "Skeeter Hawk Replacement Repellent for the Mosquito Wristband and Carabiner 2 Pack Blue", "3001194", "AZ", "PARADISE VALLEY", "85253", "Home & Garden", "Insect & Pest Repellent", "", "", "Seller Fulfilled", "", ""],
].map((row) => row.join("\t")).join("\n");

const parsed = parseWalmartImport("", `${header}\nNumber of Lines in file 81\n${settlementRows}`);
assert.equal(parsed.batch?.length, 2, "transaction report should create actual order groups");
assert.ok(parsed.batch?.some((entry) => /Skeeter Hawk/i.test(entry.order.product_name)), "preview should summarize by item name");
assert.ok(parsed.batch?.some((entry) => /FRAM Ultra/i.test(entry.order.product_name)), "preview should keep product names from settlement rows");

for (const entry of parsed.batch ?? []) {
  assert.notEqual(entry.order.product_name, "91780");
  assert.notEqual(entry.order.product_name, "85253");
  assert.notEqual(entry.order.upc, "Temple City");
  assert.notEqual(entry.order.upc, "PARADISE VALLEY");
  assert.ok(entry.order.subtotal > 0, "preview sales amount should not default to zero");
  assert.ok(entry.order.shipping_cost > 0, "shipping label cost should be captured");
  assert.ok(entry.transactions.some((transaction) => /Walmart Service Fee/i.test(transaction.transaction_type)), "commission line should stay with the order");
  assert.ok(entry.transactions.some((transaction) => /Shipping Label/i.test(transaction.transaction_type)), "shipping label line should stay with the order");
}

const sameCustomerOrderDifferentEvents = parseWalmartImport("", `${header}\n${[
  ["", "", "", "", "2026_04_20_742224", "4/19/2026", "Sale", "Purchase", "200014318360369", "1", "1.19111E+14", "1", "19.99", "Product Price", "1", "", "", "", "37321002277", "37321002277", "Bonide Go Away! Deer & Rabbit Repellent Granules 3 lb. Ready-to-Use Deterrent", "3001194", "NE", "North Platte", "69101", "Home & Garden", "Insect & Pest Repellent", "BSE-66-7.0", "Marketplace standard", "Seller Fulfilled", "Delivery", ""],
  ["", "", "", "", "2026_04_20_742224", "4/19/2026", "Sale", "Purchase", "200014318360369", "1", "1.19111E+14", "1", "-3", "Commission on Product", "1", "15", "15", "", "37321002277", "37321002277", "Bonide Go Away! Deer & Rabbit Repellent Granules 3 lb. Ready-to-Use Deterrent", "3001194", "NE", "North Platte", "69101", "Home & Garden", "Insect & Pest Repellent", "BSE-66-7.0", "Marketplace standard", "Seller Fulfilled", "Delivery", "-3"],
  ["", "", "", "", "2026_04_20_776065", "4/19/2026", "Adjustment", "Walmart Shipping Label Service Charge", "200014318360369", "1", "1.19111E+14", "1", "-11.33", "Fee/Reimbursement", "", "", "", "", "37321002277", "37321002277", "Bonide Go Away! Deer & Rabbit Repellent Granules 3 lb. Ready-to-Use Deterrent", "3001194", "NE", "North Platte", "69101", "Home & Garden", "Insect & Pest Repellent", "", "", "Seller Fulfilled", "", ""],
].map((row) => row.join("\t")).join("\n")}`);
assert.equal(sameCustomerOrderDifferentEvents.batch, undefined, "same customer order should not split into multiple imported orders");
assert.equal(sameCustomerOrderDifferentEvents.order.po_number, "200014318360369", "customer order number should be the primary group key when it is available");
assert.equal(sameCustomerOrderDifferentEvents.order.subtotal, 19.99, "product price should stay on the order");
assert.equal(sameCustomerOrderDifferentEvents.order.shipping_cost, 11.33, "shipping label event should stay with the same order");
assert.ok(sameCustomerOrderDifferentEvents.transactions.some((transaction) => /Walmart Service Fee/i.test(transaction.transaction_type)), "commission should stay with the same order");
assert.notEqual(sameCustomerOrderDifferentEvents.order.upc, "North Platte", "city must not become UPC/GTIN");

const freeform = parseWalmartImport("", `
2026_04_20_742224 ######## Sale Purchase 2E+14 1 1.19E+14 1 19.99 Product Pr 1 37321002277 37321002277 Bonide Go Away! Deer & Rabbit Repellent Granules 3 lb. Ready-to-Use Deterrent 3001194 NE North Platte 69101 Home & Garden Insect & Pest Repellent BSE-66-7.0 Marketplace standard Seller Fulfilled Delivery
2026_04_20_742224 ######## Sale Purchase 2E+14 1 1.19E+14 1 -3 Commissi 1 15 15 37321002277 37321002277 Bonide Go Away! Deer & Rabbit Repellent Granules 3 lb. Ready-to-Use Deterrent 3001194 NE North Platte 69101 Home & Garden Insect & Pest Repellent BSE-66-7.0 Marketplace standard Seller Fulfilled Delivery
2026_04_20_776065 ######## Adjustment Walmart Shipping Label Service Charge 2E+14 1 1.19E+14 1 -11.33 Fee/Reimbursement 37321002277 37321002277 Bonide Go Away! Deer & Rabbit Repellent Granules 3 lb. Ready-to-Use Deterrent 3001194 NE North Platte 69101 Home & Garden Insect & Pest Repellent Seller Fulfilled
`);
assert.ok(freeform.order.product_name.includes("Bonide"), "freeform fallback should recover item name");
assert.notEqual(freeform.order.upc, "North Platte", "freeform fallback must not use city as UPC");
assert.ok(freeform.order.subtotal > 0, "freeform fallback should capture sales amount");

const roundedExcelVisiblePaste = parseWalmartImport("", `
2026_04_20_742224 ######## Sale Purchase 2E+14 1 1.19E+14 1 19.99 Product Pr 1 37321002277 37321002277 Bonide Go Away! Deer & Rabbit Repellent Granules 3 lb. Ready-to-Use Deterrent 3001194 NE North Platte 69101 Home & Garden Insect & Pest Repellent BSE-66-7.0 Marketplace standard Seller Fulfilled Delivery
2026_04_20_742224 ######## Sale Purchase 2E+14 1 1.19E+14 1 -3 Commissi 1 15 15 37321002277 37321002277 Bonide Go Away! Deer & Rabbit Repellent Granules 3 lb. Ready-to-Use Deterrent 3001194 NE North Platte 69101 Home & Garden Insect & Pest Repellent BSE-66-7.0 Marketplace standard Seller Fulfilled Delivery
2026_04_21_999999 ######## Sale Purchase 2E+14 1 1.19E+14 1 28.99 Product Pr 1 645397938446 645397938446 Skeeter Hawk Backyard Mosquito and Flying Insect Bait Station All-Natural Insecticide 3001194 NE Lincoln 68528 Home & Garden Insect & Pest Repellent BSE-66-7.0 Marketplace standard Seller Fulfilled Delivery
2026_04_21_999999 ######## Sale Purchase 2E+14 1 1.19E+14 1 -4.35 Commissi 1 15 15 645397938446 645397938446 Skeeter Hawk Backyard Mosquito and Flying Insect Bait Station All-Natural Insecticide 3001194 NE Lincoln 68528 Home & Garden Insect & Pest Repellent BSE-66-7.0 Marketplace standard Seller Fulfilled Delivery
`);
assert.equal(roundedExcelVisiblePaste.batch?.length, 2, "rounded Excel-visible order ids must not collapse separate sale events");
assert.ok(roundedExcelVisiblePaste.batch?.every((entry) => entry.order.product_name !== entry.order.location), "location must not become the item group");

const inventoryItem: InventoryItem = {
  id: "inv-1",
  upc: "645397938446",
  product_name: "Skeeter Hawk",
  quantity_on_hand: 2,
  unit_cost: 0.25,
  reorder_point: 0,
  needs_cost: false,
};
const added = calculateInventoryAdjustment({ item: inventoryItem, direction: "add", quantity: 3, unitCost: 1.75, supplier: "Test supplier" });
assert.equal(added.nextQuantity, 5);
assert.equal(added.unitCost, 1.75);
assert.equal(added.supplier, "Test supplier");
const removed = calculateInventoryAdjustment({ item: { ...inventoryItem, quantity_on_hand: 5 }, direction: "remove", quantity: 2, reason: "Gifted" });
assert.equal(removed.nextQuantity, 3);
assert.throws(() => calculateInventoryAdjustment({ item: inventoryItem, direction: "remove", quantity: 1 }), /removal reason/i);

const order: OrderView = {
  id: "order-1",
  po_number: "129111111111111",
  walmart_order_number: "200014663509505",
  marketplace: "Walmart",
  status: "Shipped",
  subtotal: 15.98,
  shipping_fee_charged: 0,
  taxes: 0,
  customer_total: 15.98,
  amount_adjusted: 0,
  items: [{ id: "item-1", order_id: "order-1", inventory_item_id: "inv-1", upc: "645397938446", product_name: "Skeeter Hawk", quantity: 2, unit_price: 7.99, subtotal: 15.98, unit_cost: 0, total_cogs: 0 }],
  fees: [{ id: "fee-1", order_id: "order-1", fee_type: "Walmart Service Fee", amount: 2.4, source: "transaction" }],
  shipments: [{ id: "ship-1", order_id: "order-1", shipping_cost: 6.07 }],
  transactions: [],
};
const profitAtZeroCost = orderProfit(order, [{ ...inventoryItem, unit_cost: 0 }]);
const profitAtRealCost = orderProfit(order, [{ ...inventoryItem, unit_cost: 1.75 }]);
assert.equal(Number((profitAtZeroCost - profitAtRealCost).toFixed(2)), 3.5, "profit should recalculate when COGS changes");

console.log("Regression tests passed.");
