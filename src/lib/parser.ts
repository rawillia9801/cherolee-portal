import type { ParsedImport, ParsedOrder, ParsedTransaction } from "./types";

const moneyPattern = String.raw`[-+]?\$?\s*[\d,]+(?:\.\d{2})?`;

function cleanText(text: string) {
  return text.replace(/\r/g, "\n").replace(/[ \t]+/g, " ").trim();
}

function compact(text: string) {
  return cleanText(text).replace(/\n+/g, "\n");
}

function textLines(text: string) {
  return compact(text).split("\n").map((line) => line.trim()).filter(Boolean);
}

function matchValue(text: string, labels: string[], fallback = "") {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sameLine = text.match(new RegExp(`${escaped}\\s*[:#]\\s*([^\\n]+)`, "i"))?.[1]?.trim();
    if (sameLine) return sameLine.replace(/^\W+/, "").trim();

    const lines = textLines(text);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (new RegExp(`^${escaped}\\s*[:#]?\\s*$`, "i").test(line)) {
        return lines[index + 1]?.replace(/^\W+/, "").trim() ?? fallback;
      }
      const inline = line.match(new RegExp(`^${escaped}\\s+(.+)$`, "i"))?.[1]?.trim();
      if (inline) return inline.replace(/^\W+/, "").trim();
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

function allMoneyValues(text: string) {
  return [...text.matchAll(new RegExp(moneyPattern, "g"))]
    .map((match) => toNumber(match[0]))
    .filter((value) => value !== 0);
}

function firstNumberAfter(text: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = text.match(new RegExp(`${escaped}\\D+(\\d+)`, "i"))?.[1];
  return found ? Number.parseInt(found, 10) : 0;
}

function inferOrderAmounts(text: string, quantity: number) {
  const money = allMoneyValues(text).map((value) => Math.abs(value));
  const customerTotal = matchMoney(text, ["Order total", "Customer total", "Total"]);
  const taxes = matchMoney(text, ["Taxes and other fees", "Taxes", "Tax"]);
  const subtotal = matchMoney(text, ["Subtotal", "Item subtotal", "Product subtotal"]);
  const unitPrice = matchMoney(text, ["Sale price", "Unit price", "Price"]);

  const inferredTotal = customerTotal || money.at(-1) || 0;
  const inferredTax = taxes || (money.length >= 2 ? money.find((value) => value < 10 && value !== unitPrice) ?? 0 : 0);
  const inferredSubtotal =
    subtotal ||
    money.find((value) => quantity > 1 && Math.abs(value / quantity - 7.99) < 0.01) ||
    (inferredTotal && inferredTax ? Number((inferredTotal - inferredTax).toFixed(2)) : 0);
  const inferredUnitPrice =
    unitPrice ||
    (quantity > 0 && inferredSubtotal ? Number((inferredSubtotal / quantity).toFixed(2)) : 0);

  return {
    subtotal: Number(inferredSubtotal.toFixed(2)),
    unitPrice: Number(inferredUnitPrice.toFixed(2)),
    taxes: Number(inferredTax.toFixed(2)),
    customerTotal: Number(inferredTotal.toFixed(2)),
  };
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
  const quantity = Math.max(
    1,
    Math.round(matchNumber(text, ["Quantity sold", "Quantity", "Qty"], firstNumberAfter(text, "Qty") || 1)),
  );
  const inferred = inferOrderAmounts(text, quantity);
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
    unit_price: inferred.unitPrice,
    subtotal: inferred.subtotal,
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
    taxes: inferred.taxes,
    customer_total: inferred.customerTotal,
    amount_adjusted: matchMoney(text, ["Amount adjusted", "Adjustment"], 0),
    status: matchValue(text, ["Shipping status", "Order status", "Status"], "Parsed"),
  };
}

function normalizeTransactionRows(transactionText: string) {
  const lines = textLines(transactionText);
  const rows: string[] = [];
  let current = "";

  for (const line of lines) {
    if (/\b1\d{14}\b/.test(line) && current) {
      rows.push(current.trim());
      current = line;
      continue;
    }
    current = current ? `${current} ${line}` : line;
    if (/\b(Pending|Paid|Posted|Complete|Completed)\b/i.test(line) && current) {
      rows.push(current.trim());
      current = "";
    }
  }
  if (current) rows.push(current.trim());
  return rows.length ? rows : lines;
}

function parseTransactionLine(line: string, fallbackPo: string): ParsedTransaction | null {
  if (!/(sale|fee|service|payable|transaction)/i.test(line)) return null;
  const po = findFirst(line, /\b(1\d{14})\b/, fallbackPo);
  const itemId =
    findFirst(line, /\b(?:item id|item)\s*[:#]?\s*(\d{6,})\b/i) ||
    findFirst(line, /\b(?:Sale|Walmart Service Fee|Referral Fee|Payment Processing)\s+(\d{6,})\b/i);
  const type =
    findFirst(line, /\b(Walmart Service Fee|Referral Fee|Payment Processing|Sale|Refund|Adjustment)\b/i) ||
    "Transaction";
  const moneyMatches = [...line.matchAll(new RegExp(moneyPattern, "g"))].map((match) => match[0]);
  const netPayable = moneyMatches.length ? toNumber(moneyMatches[moneyMatches.length - 1]) : 0;
  const quantity =
    Number.parseInt(findFirst(line, /\b(?:qty|quantity)\s*[:#]?\s*(\d+)/i), 10) ||
    Number.parseInt(findFirst(line, /\b(?:Sale|Walmart Service Fee|Referral Fee|Payment Processing)\s+\d{6,}\s+(\d+)\b/i, "1"), 10);
  const date = normalizeDate(findFirst(line, /(\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4})/));

  return {
    po_number: po,
    transaction_date: date,
    transaction_type: type,
    item_id: itemId,
    quantity: Number.isNaN(quantity) ? 1 : quantity,
    net_payable: /fee|service|referral|processing/i.test(type)
      ? -Math.abs(Number(netPayable.toFixed(2)))
      : Number(netPayable.toFixed(2)),
    status: findFirst(line, /\b(Pending|Paid|Posted|Complete|Completed)\b/i),
    raw_text: line,
  };
}

function parseTransactions(transactionText: string, fallbackPo: string): ParsedTransaction[] {
  const text = compact(transactionText);
  if (!text) return [];
  const lines = normalizeTransactionRows(text);
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
