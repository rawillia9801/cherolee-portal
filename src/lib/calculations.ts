import type { InventoryItem, OrderView } from "./types";

export function currency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value || 0);
}

export function percent(value: number) {
  return `${(value || 0).toFixed(1)}%`;
}

export function orderGross(order: OrderView) {
  return order.items.reduce((sum, item) => sum + Number(item.subtotal || 0), 0) || Number(order.subtotal || 0);
}

export function orderFees(order: OrderView) {
  return order.fees.reduce((sum, fee) => sum + Math.abs(Number(fee.amount || 0)), 0);
}

export function orderShipping(order: OrderView) {
  return order.shipments.reduce((sum, shipment) => sum + Number(shipment.shipping_cost || 0), 0);
}

export function orderCogs(order: OrderView, inventory: InventoryItem[]) {
  return order.items.reduce((sum, item) => {
    const currentCost = inventory.find((inventoryItem) => inventoryItem.upc === item.upc)?.unit_cost;
    const unitCost = Number(currentCost ?? item.unit_cost ?? 0);
    return sum + unitCost * Number(item.quantity || 0);
  }, 0);
}

export function orderProfit(order: OrderView, inventory: InventoryItem[]) {
  return orderGross(order) - orderFees(order) - orderShipping(order) - orderCogs(order, inventory);
}

export function orderMargin(order: OrderView, inventory: InventoryItem[]) {
  const gross = orderGross(order);
  return gross ? (orderProfit(order, inventory) / gross) * 100 : 0;
}

export function dashboardMetrics(orders: OrderView[], inventory: InventoryItem[]) {
  const grossRevenue = orders.reduce((sum, order) => sum + orderGross(order), 0);
  const walmartFees = orders.reduce((sum, order) => sum + orderFees(order), 0);
  const shippingCosts = orders.reduce((sum, order) => sum + orderShipping(order), 0);
  const totalCogs = orders.reduce((sum, order) => sum + orderCogs(order, inventory), 0);
  const unitsSold = orders.reduce((sum, order) => sum + order.items.reduce((itemSum, item) => itemSum + item.quantity, 0), 0);
  const pendingTransactions = orders.reduce(
    (sum, order) => sum + order.transactions.filter((transaction) => /pending/i.test(transaction.status || "")).length,
    0,
  );
  const lowStock = inventory.filter((item) => item.quantity_on_hand <= item.reorder_point).length;
  const needsCost = inventory.filter((item) => item.needs_cost || !Number(item.unit_cost)).length;

  return {
    grossRevenue,
    netProfit: grossRevenue - walmartFees - shippingCosts - totalCogs,
    walmartFees,
    shippingCosts,
    totalCogs,
    unitsSold,
    ordersCount: orders.length,
    pendingTransactions,
    needsCost,
    lowStock,
  };
}

export function profitTrend(orders: OrderView[], inventory: InventoryItem[]) {
  const byDate = new Map<string, { date: string; gross: number; profit: number }>();
  for (const order of orders) {
    const date = order.order_date || "Undated";
    const current = byDate.get(date) ?? { date, gross: 0, profit: 0 };
    current.gross += orderGross(order);
    current.profit += orderProfit(order, inventory);
    byDate.set(date, current);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function salesByItem(orders: OrderView[], inventory: InventoryItem[]) {
  const byItem = new Map<string, { name: string; sales: number; units: number; profit: number }>();
  for (const order of orders) {
    for (const item of order.items) {
      const current = byItem.get(item.upc) ?? { name: item.product_name, sales: 0, units: 0, profit: 0 };
      const itemGross = Number(item.subtotal || 0);
      const itemCost = Number(inventory.find((inventoryItem) => inventoryItem.upc === item.upc)?.unit_cost ?? item.unit_cost ?? 0);
      current.sales += itemGross;
      current.units += Number(item.quantity || 0);
      current.profit += itemGross - itemCost * Number(item.quantity || 0);
      byItem.set(item.upc, current);
    }
  }
  return [...byItem.values()].sort((a, b) => b.sales - a.sales);
}

export function feeBreakdown(orders: OrderView[]) {
  const fees = new Map<string, number>();
  for (const order of orders) {
    for (const fee of order.fees) {
      const key = fee.fee_type || "Other fees";
      fees.set(key, (fees.get(key) ?? 0) + Math.abs(Number(fee.amount || 0)));
    }
  }
  return [...fees.entries()].map(([name, value]) => ({ name, value }));
}
