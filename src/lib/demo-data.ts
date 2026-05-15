import type { InventoryItem, OrderFee, OrderItem, OrderView, Shipment, Transaction } from "./types";

export const demoInventory: InventoryItem[] = [
  {
    id: "inv-1",
    upc: "645397938446",
    sku: "CH-SHR-6",
    product_name: "Skeeter Hawk Repellent",
    marketplace: "Walmart",
    walmart_item_id: "87610234",
    quantity_on_hand: 42,
    unit_cost: 2.85,
    reorder_point: 12,
    needs_cost: false,
    supplier: "Cherolee wholesale",
    notes: "Core replenishment item",
  },
  {
    id: "inv-2",
    upc: "712345678901",
    sku: "CH-MWB",
    product_name: "Mosquito Wristband",
    marketplace: "Walmart",
    walmart_item_id: "87610235",
    quantity_on_hand: 15,
    unit_cost: 1.35,
    reorder_point: 20,
    needs_cost: false,
  },
  {
    id: "inv-3",
    upc: "812345678901",
    sku: "CH-CAR2",
    product_name: "Carabiner 2 Pack",
    marketplace: "Walmart",
    walmart_item_id: "87610236",
    quantity_on_hand: 8,
    unit_cost: 0.95,
    reorder_point: 10,
    needs_cost: false,
  },
  {
    id: "inv-4",
    upc: "845678901234",
    sku: null,
    product_name: "Travel Size Repellent",
    marketplace: "Walmart",
    walmart_item_id: "87610237",
    quantity_on_hand: 23,
    unit_cost: 0,
    reorder_point: 8,
    needs_cost: true,
  },
];

function order(
  id: string,
  po: string,
  walmartOrder: string,
  product: string,
  upc: string,
  quantity: number,
  unitPrice: number,
  customer: string,
  total: number,
  fees: number,
  shipping: number,
  unitCost: number,
  date: string,
): OrderView {
  const subtotal = Number((quantity * unitPrice).toFixed(2));
  const orderItem: OrderItem = {
    id: `${id}-item`,
    order_id: id,
    inventory_item_id: demoInventory.find((item) => item.upc === upc)?.id,
    upc,
    product_name: product,
    walmart_item_id: demoInventory.find((item) => item.upc === upc)?.walmart_item_id,
    quantity,
    unit_price: unitPrice,
    subtotal,
    unit_cost: unitCost,
    total_cogs: Number((quantity * unitCost).toFixed(2)),
  };
  const orderFee: OrderFee = {
    id: `${id}-fee`,
    order_id: id,
    fee_type: "Walmart Service Fee",
    amount: fees,
    source: "transaction",
    transaction_date: date,
    status: "Posted",
  };
  const shipment: Shipment = {
    id: `${id}-ship`,
    order_id: id,
    carrier: "USPS",
    tracking_number: "9400111100000000000000",
    shipping_status: "Shipped",
    method: "Ground Advantage",
    shipping_cost: shipping,
    estimated_delivery: "May 18, 2026",
  };
  const transaction: Transaction = {
    id: `${id}-txn`,
    order_id: id,
    po_number: po,
    transaction_date: date,
    transaction_type: "Sale",
    item_id: orderItem.walmart_item_id,
    quantity,
    net_payable: Number((subtotal - fees).toFixed(2)),
    status: "Posted",
  };

  return {
    id,
    po_number: po,
    walmart_order_number: walmartOrder,
    marketplace: "Walmart",
    order_date: date,
    ship_by: date,
    deliver_by: "2026-05-18",
    customer_name: customer,
    status: "Shipped",
    subtotal,
    shipping_fee_charged: 0,
    taxes: Number((total - subtotal).toFixed(2)),
    customer_total: total,
    amount_adjusted: 0,
    items: [orderItem],
    fees: [orderFee],
    shipments: [shipment],
    transactions: [transaction],
  };
}

export const demoOrders: OrderView[] = [
  order("ord-1", "119113696422784", "200014533145443", "Skeeter Hawk Repellent", "645397938446", 6, 7.99, "Z Smith", 51.18, 6.54, 6.54, 2.85, "2026-05-15"),
  order("ord-2", "119113695112233", "200014532998877", "Mosquito Wristband", "712345678901", 2, 18.96, "J Johnson", 37.92, 5.12, 5.98, 1.35, "2026-05-14"),
  order("ord-3", "119113694998877", "200014532887766", "Carabiner 2 Pack", "812345678901", 1, 23.45, "A Williams", 23.45, 3.21, 4.25, 0.95, "2026-05-14"),
  order("ord-4", "119113694776655", "200014532776655", "Bug Repellent Spray", "912345678901", 3, 20.37, "M Brown", 62.11, 8.35, 7.18, 3.25, "2026-05-13"),
  order("ord-5", "119113694554433", "200014532665544", "Travel Size Repellent", "845678901234", 1, 18.99, "D Davis", 18.99, 2.87, 3.86, 0, "2026-05-13"),
];

export const sampleOrderPaste = `Shipped
Skeeter Hawk Replacement Repellent for the Mosquito Wristband and Carabiner, 2 Pack, Blue
Variant: 1
645397938446
Condition: New
$7.99

x2
Shipping details
ZPL text format
Carrier / Tracking
USPS9400136207565359624568
Shipping status
Shipped
Est. delivery
Fri, May 22 - USPS Ground Advantage
Est. cost
$6.07
Shipping label
print-format
Default label - 4 x 6 in PDF
Change format
Print Label
Order details
Order#:
200014663509505
Ship node:
Cherolee LLC - 10001327162 - MP
Ship node ID:
10001327162
Ship method:
Standard
Carrier method:
USPS_GROUND
Ordered:
05/14/2026
Ship by:
05/15/2026
Deliver by:
05/21/2026
Fulfilled by:
Seller
Customer details
Christopher Marrs
3197 Perlett Dr
Cameron Park, CA 95682
(530) 503-7060*
Subtotal (1 item)
$15.98
Shipping fee:
$0.00
Taxes and other fees:
$1.16
Total:
$17.14
Amount Adjusted:
$0.00
View payment details`;

export const sampleTransactionPaste = "";
