import type { ParsedImport, ParsedOrder, ParsedTransaction } from "./types";

const moneyPattern = String.raw`[-+]?\$?\s*[\d,]+(?:\.\d{2})?`;

function cleanText(text: string) {
  return text.replace(/\r/g, "\n").replace(/[ \t]+/g, " ").trim();
}

function compact(text: string) {
  return cleanText(text).replace(/\n+/g, "\n");
}

function matchValue(text: string, labels: string[], fallback = "") {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regexes = [
      new RegExp(`${escaped}\\s*[:#]?\\s*([^\\n]+)`, "i"),
      new RegExp(`${escaped}\\s*\\n\\s*([^\\n]+)`, "i"),
    ];
    for (const regex of regexes) {
      const found = text.match(regex)?.[1]?.trim();
      if (found) return found.replace(/^\W+/, "").trim();
    }
  }
  return fallback;
}

function matchNumber(text: string, labels: string[], fallback = 0) {
  const raw = matchValue(text, labels);
  return raw ? toNumber(raw) : fallback;
}

function toNumber(value: string | number | undefined | null) {
  if (typeof value === "number") return value;
  if (!value) return 0;
  const negative = /\(|-/.test(value);
  const cleaned = value.replace(/[^\d.]/g, "");
  const parsed = Number.parseFloat(cleaned);
  if (Number.isNaN(parsed)) return 0;
  return negative ? -Math.abs(parsed) : parsed;
}

function toPositiveMoney(value: string | number | undefined | null) {
  return Math.abs(toNumber(value));
}

function matchMoney(text: string, labels: string[], fallback = 0) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const found = text.match(new RegExp(`${escaped}\\s*[:#]?\\s*(${moneyPattern})`, "i"))?.[1];
    if (found) return toPositiveMoney(found);
  }
  const raw = matchValue(text, labels);
  return raw ? toPositiveMoney(raw) : fallback;
}

function normalizeDate(raw?: string) {
  if (!raw) return undefined;
  const dateOnly = raw
    .replace(/(?:order|ship|deliver|transaction|date|by)/gi, "")
    .replace(/[,]+/g, ",")
    .trim();
  const parsed = new Date(dateOnly);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().slice(0, 10);
}

function findFirst(text: string, regex: RegExp, fallback = "") {
  return text.match(regex)?.[1]?.trim() ?? fallback;
}

function parseOrderDetails(orderText: string): ParsedOrder {
  const text = compact(orderText);
  const po =
    matchValue(text, ["PO number", "PO #", "Purchase order", "PO"]) ||
    findFirst(text, /\b(1\d{14})\b/);
  const order =
    matchValue(text, ["Walmart order number", "Order number", "Order #"]) ||
    findFirst(text, /\b(2\d{14})\b/);
  const upc = matchValue(text, ["UPC", "GTIN"]) || findFirst(text, /\b(\d{12,14})\b/);
  const quantity = Math.max(1, Math.round(matchNumber(text, ["Quantity sold", "Quantity", "Qty"], 1)));
  const subtotal = matchMoney(text, ["Subtotal", "Item subtotal", "Product subtotal"]);
  const unitPrice =
    matchMoney(text, ["Sale price", "Unit price", "Price"]) ||
    (quantity > 0 && subtotal ? subtotal / quantity : 0);
  const title =
    matchValue(text, ["Product title", "Item title", "Product name", "Item"]) ||
    "Unlabeled Walmart item";

  return {
    po_number: po,
    walmart_order_number: order,
    product_name: title,
    upc,
    item_condition: matchValue(text, ["Item condition", "Condition"]),
    walmart_item_id: matchValue(text, ["Item ID", "Walmart item ID", "Marketplace item ID"]),
    quantity,
    unit_price: Number(unitPrice.toFixed(2)),
    subtotal: Number((subtotal || unitPrice * quantity).toFixed(2)),
    carrier: matchValue(text, ["Carrier"]),
    tracking_number: matchValue(text, ["Tracking number", "Tracking #"]),
    shipping_status: matchValue(text, ["Shipping status", "Shipment status", "Status"]),
    estimated_delivery: matchValue(text, ["Estimated delivery", "Estimated delivery date"]),
    shipping_cost: matchMoney(text, ["Estimated shipping cost", "Shipping cost", "Label cost"]),
    order_date: normalizeDate(matchValue(text, ["Order date", "Date ordered"])),
    ship_by: normalizeDate(matchValue(text, ["Ship-by date", "Ship by", "Ship-by"])),
    deliver_by: normalizeDate(matchValue(text, ["Deliver-by date", "Deliver by", "Deliver-by"])),
    customer_name: matchValue(text, ["Customer name", "Customer"]),
    shipping_fee_charged: matchMoney(text, ["Shipping fee charged to customer", "Shipping fee", "Shipping"]),
    taxes: matchMoney(text, ["Taxes and other fees", "Taxes", "Tax"]),
    customer_total: matchMoney(text, ["Order total", "Customer total", "Total"]),
    amount_adjusted: matchMoney(text, ["Amount adjusted", "Adjustment"], 0),
    status: matchValue(text, ["Shipping status", "Order status", "Status"], "Parsed"),
  };
}

function parseTransactionLine(line: string, fallbackPo: string): ParsedTransaction | null {
  if (!/(sale|fee|service|payable|transaction)/i.test(line)) return null;
  const po = findFirst(line, /\b(1\d{14})\b/, fallbackPo);
  const itemId = findFirst(line, /\b(?:item id|item)\s*[:#]?\s*(\d{6,})\b/i);
  const type =
    findFirst(line, /\b(Walmart Service Fee|Referral Fee|Payment Processing|Sale|Refund|Adjustment)\b/i) ||
    "Transaction";
  const moneyMatches = [...line.matchAll(new RegExp(moneyPattern, "g"))].map((match) => match[0]);
  const netPayable = moneyMatches.length ? toNumber(moneyMatches[moneyMatches.length - 1]) : 0;
  const quantity = Number.parseInt(findFirst(line, /\b(?:qty|quantity)\s*[:#]?\s*(\d+)/i, "1"), 10);
  const date = normalizeDate(findFirst(line, /(\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4})/));

  return {
    po_number: po,
    transaction_date: date,
    transaction_type: type,
    item_id: itemId,
    quantity: Number.isNaN(quantity) ? 1 : quantity,
    net_payable: Number(netPayable.toFixed(2)),
    status: findFirst(line, /\b(Pending|Paid|Posted|Complete|Completed)\b/i),
    raw_text: line,
  };
}

function parseTransactions(transactionText: string, fallbackPo: string): ParsedTransaction[] {
  const text = compact(transactionText);
  if (!text) return [];
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const parsed = lines.map((line) => parseTransactionLine(line, fallbackPo)).filter(Boolean) as ParsedTransaction[];

  if (parsed.length) return parsed;

  const type = matchValue(text, ["Transaction type"], "Transaction");
  const net = matchMoney(text, ["Net payable", "Amount", "Total"], 0);
  return [
    {
      po_number: matchValue(text, ["PO number", "PO #"], fallbackPo),
      transaction_date: normalizeDate(matchValue(text, ["Transaction date", "Date"])),
      transaction_type: type,
      item_id: matchValue(text, ["Item ID", "Item"]),
      quantity: Math.max(1, Math.round(matchNumber(text, ["Quantity", "Qty"], 1))),
      net_payable: /fee/i.test(type) ? -Math.abs(net) : net,
      status: matchValue(text, ["Status"]),
      raw_text: text,
    },
  ];
}

export function parseWalmartImport(orderText: string, transactionText: string): ParsedImport {
  const order = parseOrderDetails(orderText);
  const transactions = parseTransactions(transactionText, order.po_number);
  const feeFromTransactions = transactions
    .filter((transaction) => /fee|service|referral|processing/i.test(transaction.transaction_type))
    .reduce((sum, transaction) => sum + Math.abs(transaction.net_payable), 0);
  const warnings: string[] = [];

  if (!order.po_number) warnings.push("PO number was not found.");
  if (!order.walmart_order_number) warnings.push("Walmart order number was not found.");
  if (!order.upc) warnings.push("UPC was not found; inventory matching will need manual correction.");
  if (!order.subtotal) warnings.push("Subtotal was not found.");
  if (!order.customer_total && order.subtotal) {
    order.customer_total = Number((order.subtotal + order.shipping_fee_charged + order.taxes).toFixed(2));
  }
  if (!order.shipping_cost && feeFromTransactions) {
    order.shipping_cost = Number(feeFromTransactions.toFixed(2));
  }

  return { order, transactions, warnings, raw_order_text: orderText, raw_transaction_text: transactionText };
}
