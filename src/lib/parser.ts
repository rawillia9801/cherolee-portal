import type { ParsedImport, ParsedOrder, ParsedTransaction } from "./types";

const moneyPattern = String.raw`[-+]?\$?\s*[\d,]+(?:\.\d{2})?`;
const walmartCommissionRate = 0.15;

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
  const lines = textLines(text);
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const found = text.match(new RegExp(`${escaped}\\s*[:#]?\\s*(${moneyPattern})`, "i"))?.[1];
    if (found) return toPositiveMoney(found);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!new RegExp(`^${escaped}\\b`, "i").test(line)) continue;
      const sameLineMoney = line.includes("$") ? line.match(new RegExp(`(${moneyPattern})`, "i"))?.[1] : "";
      if (sameLineMoney) return toPositiveMoney(sameLineMoney);
      const nextLineMoney = lines[index + 1]?.match(new RegExp(`(${moneyPattern})`, "i"))?.[1];
      if (nextLineMoney) return toPositiveMoney(nextLineMoney);
    }
  }
  return fallback;
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

function normalizeIdentifier(value?: string) {
  if (!value) return "";
  const trimmed = value.trim();
  if (!/[eE]\+/.test(trimmed)) return trimmed.replace(/\.0+$/, "");
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return trimmed;
  return parsed.toLocaleString("en-US", { maximumFractionDigits: 0, useGrouping: false });
}

function normalizeHeader(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function delimitedCells(line: string) {
  if (line.includes("\t")) return line.split("\t").map((cell) => cell.trim());
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of line) {
    if (char === "\"") {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function headerIndex(headers: string[], candidates: string[]) {
  const normalized = headers.map(normalizeHeader);
  for (const candidate of candidates.map(normalizeHeader)) {
    const exact = normalized.findIndex((header) => header === candidate);
    if (exact >= 0) return exact;
  }
  for (const candidate of candidates.map(normalizeHeader)) {
    const partial = normalized.findIndex((header) => header.includes(candidate) || candidate.includes(header));
    if (partial >= 0) return partial;
  }
  return -1;
}

function cell(row: string[], index: number) {
  return index >= 0 ? row[index]?.trim() ?? "" : "";
}

function transactionKind(type: string, description: string, amountType: string) {
  const joined = `${type} ${description} ${amountType}`;
  if (/refund|return/i.test(joined)) return "Refund";
  if (/shipping label/i.test(joined)) return "Shipping Label";
  if (/commission/i.test(joined)) return "Walmart Service Fee";
  if (/service fee|storagefee|inventory|reserve|wfs|fee/i.test(joined)) return type || amountType || "Service Fee";
  if (/sale|purchase|product/i.test(joined)) return "Sale";
  return type || amountType || "Transaction";
}

function parseTransactionReport(transactionText: string, fallbackPo: string): ParsedTransaction[] {
  const rawLines = transactionText.replace(/\r/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
  const headerLineIndex = rawLines.findIndex((line) => /transaction\s*type/i.test(line) && /amount/i.test(line));
  if (headerLineIndex < 0) return [];

  const headers = delimitedCells(rawLines[headerLineIndex]);
  const indexes = {
    type: headerIndex(headers, ["Transaction Type"]),
    description: headerIndex(headers, ["Transaction Description"]),
    customerOrder: headerIndex(headers, ["Customer Order #", "Customer Order"]),
    purchaseOrder: headerIndex(headers, ["Purchase Order", "PO Number", "PO #"]),
    amount: headerIndex(headers, ["Amount"]),
    amountType: headerIndex(headers, ["Amount Type"]),
    quantity: headerIndex(headers, ["Ship Qty", "Quantity", "Qty"]),
    itemId: headerIndex(headers, ["Partner Item ID", "Item ID", "Product ID", "Product"]),
    status: headerIndex(headers, ["Transaction Status", "Status"]),
    date: headerIndex(headers, ["Transaction Date", "Date"]),
  };

  return rawLines
    .slice(headerLineIndex + 1)
    .map((line) => ({ line, row: delimitedCells(line) }))
    .filter(({ row }) => row.some(Boolean))
    .map(({ line, row }) => {
      const type = cell(row, indexes.type);
      const description = cell(row, indexes.description);
      const amountType = cell(row, indexes.amountType);
      const amount = toNumber(cell(row, indexes.amount));
      const po =
        normalizeIdentifier(cell(row, indexes.purchaseOrder)) ||
        normalizeIdentifier(cell(row, indexes.customerOrder)) ||
        fallbackPo;
      const kind = transactionKind(type, description, amountType);
      const feeLike = /fee|commission|shipping label|reserve|wfs|storage|refund/i.test(kind);
      const signedAmount = feeLike ? -Math.abs(amount) : amount;
      const quantity = Number.parseInt(cell(row, indexes.quantity), 10);

      return {
        po_number: po,
        transaction_date: normalizeDate(cell(row, indexes.date)),
        transaction_type: kind,
        item_id: normalizeIdentifier(cell(row, indexes.itemId)),
        quantity: Number.isNaN(quantity) || quantity < 1 ? 1 : quantity,
        net_payable: Number(signedAmount.toFixed(2)),
        status: cell(row, indexes.status) || amountType || "Imported",
        raw_text: line,
      };
    })
    .filter((transaction) => transaction.po_number && transaction.transaction_type && transaction.net_payable !== 0);
}

function firstNumberAfter(text: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = text.match(new RegExp(`${escaped}\\D+(\\d+)`, "i"))?.[1];
  return found ? Number.parseInt(found, 10) : 0;
}

function valueAfterLine(text: string, label: string) {
  const lines = textLines(text);
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const inline = line.match(new RegExp(`^${escaped}\\s*:?\\s*(.+)$`, "i"))?.[1]?.trim();
    if (inline) return inline;
    if (new RegExp(`^${escaped}\\s*:?\\s*$`, "i").test(line)) return lines[index + 1] ?? "";
  }
  return "";
}

function productTitleFromSellerCenter(text: string) {
  const lines = textLines(text);
  const variantIndex = lines.findIndex((line) => /^Variant:/i.test(line));
  if (variantIndex > 0) return lines[variantIndex - 1];

  const statusWords = new Set(["shipped", "pending", "delivered", "cancelled", "canceled"]);
  return (
    lines.find((line) => {
      if (statusWords.has(line.toLowerCase())) return false;
      if (/^(shipping|order|customer)\b/i.test(line)) return false;
      if (/^(variant|condition|carrier|tracking|est\.|subtotal|total|taxes|amount|ship|deliver|ordered):?/i.test(line)) return false;
      if (/^\$/.test(line) || /^x\d+/i.test(line) || /^\d{12,14}$/.test(line)) return false;
      return line.length > 12;
    }) || ""
  );
}

function quantityFromSellerCenter(text: string) {
  return Number.parseInt(findFirst(text, /^\s*x\s*(\d+)\s*$/im), 10) || 0;
}

function customerNameFromSellerCenter(text: string) {
  return valueAfterLine(text, "Customer details");
}

function carrierTrackingFromSellerCenter(text: string) {
  const raw = valueAfterLine(text, "Carrier / Tracking") || matchValue(text, ["Tracking number", "Tracking #"]);
  const packed = raw.match(/^([A-Z]+)\s*([A-Z0-9]{12,})$/i);
  if (!packed) return { carrier: matchValue(text, ["Carrier"]), tracking: raw };
  return { carrier: packed[1].toUpperCase(), tracking: packed[2] };
}

function inferOrderAmounts(text: string, quantity: number) {
  const rawTotal = matchMoney(text, ["Order total", "Customer total", "Total"]);
  const ignoredTax = matchMoney(text, ["Taxes and other fees", "Taxes", "Tax"]);
  const rawSubtotal = matchMoney(text, ["Subtotal", "Item subtotal", "Product subtotal"]);
  const customerShippingPaid = matchMoney(text, ["Shipping fee charged to customer", "Shipping fee"]);
  const unitPrice =
    matchMoney(text, ["Sale price", "Unit price", "Price"]) ||
    toPositiveMoney(findFirst(text, /^\s*\$(\d+(?:\.\d{2})?)\s*$/im));

  const sellerProceeds =
    rawTotal && ignoredTax
      ? Number((rawTotal - ignoredTax).toFixed(2))
      : Number((rawSubtotal + customerShippingPaid).toFixed(2));
  const inferredUnitPrice =
    unitPrice ||
    (quantity > 0 && sellerProceeds ? Number((sellerProceeds / quantity).toFixed(2)) : 0);

  return {
    subtotal: Number(sellerProceeds.toFixed(2)),
    unitPrice: Number(inferredUnitPrice.toFixed(2)),
    taxes: 0,
    customerTotal: Number(sellerProceeds.toFixed(2)),
  };
}

function parseOrderDetails(orderText: string): ParsedOrder {
  const text = compact(orderText);
  const walmartOrderNumber =
    matchValue(text, ["Walmart order number", "Order number", "Order #", "Order#"]) ||
    findFirst(text, /\b(2\d{14})\b/);
  const po =
    matchValue(text, ["PO number", "PO #", "Purchase order", "PO"]) ||
    findFirst(text, /\b(1\d{14})\b/) ||
    walmartOrderNumber;
  const upc = matchValue(text, ["UPC", "GTIN"]) || findFirst(text, /\b(\d{12,14})\b/);
  const quantity = Math.max(
    1,
    Math.round(
      matchNumber(
        text,
        ["Quantity sold", "Quantity", "Qty"],
        quantityFromSellerCenter(text) || firstNumberAfter(text, "Qty") || 1,
      ),
    ),
  );
  const inferred = inferOrderAmounts(text, quantity);
  const carrierTracking = carrierTrackingFromSellerCenter(text);
  const title =
    productTitleFromSellerCenter(text) ||
    matchValue(text, ["Product title", "Item title", "Product name"]) ||
    "Unlabeled Walmart item";

  return {
    po_number: po,
    walmart_order_number: walmartOrderNumber,
    product_name: title,
    upc,
    item_condition: matchValue(text, ["Item condition", "Condition"]),
    walmart_item_id: matchValue(text, ["Item ID", "Walmart item ID", "Marketplace item ID"]),
    quantity,
    unit_price: inferred.unitPrice,
    subtotal: inferred.subtotal,
    carrier: carrierTracking.carrier,
    tracking_number: carrierTracking.tracking,
    shipping_status: matchValue(text, ["Shipping status", "Shipment status", "Status"]),
    estimated_delivery: matchValue(text, ["Estimated delivery", "Estimated delivery date", "Est. delivery"]),
    shipping_cost: matchMoney(text, ["Estimated shipping cost", "Est. cost", "Shipping cost", "Label cost"]),
    order_date: normalizeDate(matchValue(text, ["Order date", "Date ordered", "Ordered"])),
    ship_by: normalizeDate(matchValue(text, ["Ship-by date", "Ship by", "Ship-by"])),
    deliver_by: normalizeDate(matchValue(text, ["Deliver-by date", "Deliver by", "Deliver-by"])),
    customer_name: customerNameFromSellerCenter(text) || matchValue(text, ["Customer name", "Customer"]),
    shipping_fee_charged: matchMoney(text, ["Shipping fee charged to customer", "Shipping fee"]),
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
  const reportRows = parseTransactionReport(transactionText, fallbackPo);
  if (reportRows.length) return reportRows;

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
  const shippingFromTransactions = transactions
    .filter((transaction) => /shipping label/i.test(transaction.transaction_type))
    .reduce((sum, transaction) => sum + Math.abs(transaction.net_payable), 0);
  const warnings: string[] = [];

  if (!order.po_number) warnings.push("No PO or Walmart order number was found.");
  if (!order.walmart_order_number) warnings.push("Walmart order number was not found.");
  if (!order.upc) warnings.push("UPC was not found; inventory matching will need manual correction.");
  if (!order.subtotal) warnings.push("Subtotal was not found.");
  if (!order.customer_total && order.subtotal) order.customer_total = order.subtotal;
  if (!order.shipping_cost && shippingFromTransactions) {
    order.shipping_cost = Number(shippingFromTransactions.toFixed(2));
  }
  if (!transactions.length && order.subtotal) {
    transactions.push({
      po_number: order.po_number,
      transaction_date: order.order_date,
      transaction_type: "Walmart Service Fee",
      quantity: order.quantity,
      net_payable: -Number((order.subtotal * walmartCommissionRate).toFixed(2)),
      status: "Auto-calculated",
      raw_text: "Auto-calculated 15% Walmart commission from seller proceeds.",
    });
  }

  return { order, transactions, warnings, raw_order_text: orderText, raw_transaction_text: transactionText };
}
