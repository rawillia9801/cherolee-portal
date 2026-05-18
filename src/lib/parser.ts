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

function isReliableOrderIdentifier(value?: string) {
  if (!value) return false;
  if (/[eE]\+/.test(value)) return false;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 10) return false;
  if (/0{6,}$/.test(digits)) return false;
  return true;
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
    const partial = normalized.findIndex((header) => {
      if (!header || header.length < 4) return false;
      if (/line/.test(header) && !/line/.test(candidate)) return false;
      return header.includes(candidate);
    });
    if (partial >= 0) return partial;
  }
  return -1;
}

function cell(row: string[], index: number) {
  return index >= 0 ? row[index]?.trim() ?? "" : "";
}

function transactionKind(type: string, description: string, amountType: string) {
  const joined = `${type} ${description} ${amountType}`;
  if (/return\s*shipping/i.test(joined)) return "Return Shipping";
  if (/return\s*processing/i.test(joined)) return "WFS Return Processing Fee";
  if (/return\s*refund|refund/i.test(joined)) return "Refund";
  if (/shipping label/i.test(joined)) return "Shipping Label";
  if (/commission|commissi/i.test(joined)) return "Walmart Service Fee";
  if (/product\s*tax|product\s*ta|\btax\b/i.test(joined)) return "Tax";
  if (/wfs\s*fulfillment/i.test(joined)) return "WFS Fulfillment Fee";
  if (/storage\s*fee|storagefee/i.test(joined)) return "WFS Storage Fee";
  if (/inventory\s*removal/i.test(joined)) return "WFS Inventory Removal Fee";
  if (/inbound\s*transportation/i.test(joined)) return "WFS Inbound Transportation Fee";
  if (/reserve/i.test(joined)) return "Reserve";
  if (/service fee|wfs|fee/i.test(joined)) return description || type || amountType || "Service Fee";
  if (/sale|purchase|product\s*price|product\s*pr/i.test(joined)) return "Sale";
  return type || amountType || "Transaction";
}

function parseTransactionReport(transactionText: string, fallbackPo: string): ParsedTransaction[] {
  const rawLines = transactionText.replace(/\r/g, "\n").split("\n").filter((line) => line.trim());
  const headerLineIndex = rawLines.findIndex((line) => /transaction\s*type/i.test(line) && /amount/i.test(line));
  if (headerLineIndex < 0) return [];

  const headers = delimitedCells(rawLines[headerLineIndex]);
  if (headers.length < 8) return parseFreeformSettlementRows(transactionText, fallbackPo);
  const indexes = {
    type: headerIndex(headers, ["Transaction Type"]),
    description: headerIndex(headers, ["Transaction Description"]),
    customerOrder: headerIndex(headers, ["Customer Order #", "Customer Order"]),
    purchaseOrder: headerIndex(headers, ["Purchase Order #", "Purchase Order", "PO Number", "PO #"]),
    amount: headerIndex(headers, ["Amount"]),
    amountType: headerIndex(headers, ["Amount Type"]),
    quantity: headerIndex(headers, ["Ship Qty", "Quantity", "Qty"]),
    itemId: headerIndex(headers, ["Partner Item Id", "Partner Item ID", "Item ID"]),
    upc: headerIndex(headers, ["Partner GTIN", "UPC", "GTIN"]),
    productName: headerIndex(headers, ["Partner Item Name", "Product Name", "Product Title", "Item Name", "Item Description"]),
    status: headerIndex(headers, ["Transaction Status", "Status"]),
    date: headerIndex(headers, ["Transaction Posted Timestamp", "Transaction Date", "Date"]),
    transactionKey: headerIndex(headers, ["Transaction Key"]),
    purchaseOrderLine: headerIndex(headers, ["Purchase Order line #", "Purchase Order Line"]),
    customerOrderLine: headerIndex(headers, ["Customer Order line #", "Customer Order Line"]),
    fulfillmentType: headerIndex(headers, ["Fulfillment Type"]),
    state: headerIndex(headers, ["Ship to State"]),
    city: headerIndex(headers, ["Ship to City"]),
    zip: headerIndex(headers, ["Ship to Zipcode", "Ship to Zip", "Zipcode"]),
    category: headerIndex(headers, ["Contract Category"]),
    productType: headerIndex(headers, ["Product Type"]),
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
      const customerOrder = normalizeIdentifier(cell(row, indexes.customerOrder));
      const purchaseOrder = normalizeIdentifier(cell(row, indexes.purchaseOrder));
      const po =
        (isReliableOrderIdentifier(customerOrder) ? customerOrder : "") ||
        (isReliableOrderIdentifier(purchaseOrder) ? purchaseOrder : "") ||
        customerOrder ||
        purchaseOrder ||
        fallbackPo;
      const kind = transactionKind(type, description, amountType);
      const chargeLike = /fee|commission|shipping label|wfs|storage|refund|return shipping/i.test(kind);
      const signedAmount = chargeLike ? -Math.abs(amount) : amount;
      const quantity = Number.parseInt(cell(row, indexes.quantity), 10);
      const transactionKey = cell(row, indexes.transactionKey);
      const orderLine = cell(row, indexes.purchaseOrderLine) || cell(row, indexes.customerOrderLine);
      const reliablePo = isReliableOrderIdentifier(customerOrder) || isReliableOrderIdentifier(purchaseOrder);
      const groupKey = reliablePo
        ? po
        : [transactionKey || normalizeIdentifier(cell(row, indexes.customerOrder)), orderLine, cell(row, indexes.upc), cell(row, indexes.productName)].filter(Boolean).join("|");

      return {
        po_number: po,
        transaction_key: transactionKey,
        group_key: groupKey || po,
        transaction_date: normalizeDate(cell(row, indexes.date)),
        transaction_type: kind,
        item_id: normalizeIdentifier(cell(row, indexes.itemId)),
        upc: normalizeIdentifier(cell(row, indexes.upc)),
        product_name: cell(row, indexes.productName),
        amount_type: amountType,
        fulfillment_type: cell(row, indexes.fulfillmentType),
        category: cell(row, indexes.category),
        product_type: cell(row, indexes.productType),
        location: [cell(row, indexes.city), cell(row, indexes.state), cell(row, indexes.zip)].filter(Boolean).join(", "),
        quantity: Number.isNaN(quantity) || quantity < 1 ? 1 : quantity,
        net_payable: Number(signedAmount.toFixed(2)),
        status: cell(row, indexes.status) || amountType || "Imported",
        raw_text: line,
      };
    })
    .filter((transaction) => transaction.po_number && transaction.transaction_type && transaction.net_payable !== 0);
}

function settlementRecords(text: string) {
  const lines = text.replace(/\r/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
  const records: string[] = [];
  let current = "";
  const startPattern = /^(?:20\d{2}_\d{2}_\d{2}_\d+\s+(?:\d{1,2}\/\d{1,2}\/\d{4}|#{4,})\s+(?:Adjustment|Sale|Refund|Adjustme)|(?:\d{1,2}\/\d{1,2}\/\d{4}|#{4,})(?:\s+(?:\d{1,2}\/\d{1,2}\/\d{4}|#{4,}))*\s+(?:[\d.]+\s+USD\s+)?(?:20\d{2}_\d{2}_\d{2}_\d+|(?:\d{1,2}\/\d{1,2}\/\d{4}|#{4,})\s+(?:PaymentSummary|Release Reserve|Service Fee|Adjustment|Sale|Refund)))/i;

  for (const line of lines) {
    if (/period start date|number of lines/i.test(line)) continue;
    if (startPattern.test(line) && current) {
      records.push(current.trim());
      current = line;
      continue;
    }
    current = current ? `${current} ${line}` : line;
  }
  if (current) records.push(current.trim());
  return records;
}

function isIdLike(value: string) {
  return /^(?:\d{6,}|\d+(?:\.\d+)?E\+\d+)$/i.test(value);
}

function parseFreeformSettlementRows(transactionText: string, fallbackPo: string): ParsedTransaction[] {
  const amountTypes = [
    "WFS Inventory Fee/Reimbursement",
    "WFS Inbound Fee",
    "Fee/Reimbursement",
    "Commission on Product",
    "Commissi",
    "Product tax withheld",
    "Product Price",
    "Product tax",
    "Product Pr",
    "Product ta",
  ];
  const amountTypePattern = amountTypes.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

  const parsed: (ParsedTransaction | null)[] = settlementRecords(transactionText)
    .map((record): ParsedTransaction | null => {
      const start = record.match(/(?:(20\d{2}_\d{2}_\d{2}_\d+)\s+)?(\d{1,2}\/\d{1,2}\/\d{4}|#{4,})\s+(PaymentSummary|Release Reserve|Service Fee|Adjustment|Sale|Refund|Adjustme)\s+(.+)$/i);
      if (!start) return null;
      const [, transactionKey = "", date, startType, rest] = start;
      const amountMatch = rest.match(new RegExp(`\\s(-?\\d+(?:\\.\\d+)?)\\s+(${amountTypePattern})\\b`, "i"));
      if (!amountMatch) return null;
      const [, rawAmount, rawAmountType] = amountMatch;

      const beforeAmount = rest.slice(0, amountMatch.index).trim();
      const afterAmountType = rest.slice((amountMatch.index ?? 0) + amountMatch[0].length).trim();
      const beforeTokens = beforeAmount.split(/\s+/);
      const purchaseLine = beforeTokens.at(-1) ?? "";
      const purchaseOrder = normalizeIdentifier(beforeTokens.at(-2));
      const customerOrder = normalizeIdentifier(beforeTokens.at(-4));
      const description = beforeTokens.slice(0, Math.max(1, beforeTokens.length - 4)).join(" ") || startType;

      const afterTokens = afterAmountType.split(/\s+/).filter(Boolean);
      const quantity = Number.parseInt(afterTokens[0] ?? "1", 10);
      let itemIndex = -1;
      for (let index = 1; index < afterTokens.length - 1; index += 1) {
        if (isIdLike(afterTokens[index]) && isIdLike(afterTokens[index + 1])) {
          itemIndex = index;
          break;
        }
      }
      const itemId = itemIndex >= 0 ? normalizeIdentifier(afterTokens[itemIndex]) : "";
      const gtin = itemIndex >= 0 ? normalizeIdentifier(afterTokens[itemIndex + 1]) : "";
      let nameEnd = afterTokens.length;
      for (let index = itemIndex + 2; index < afterTokens.length - 2; index += 1) {
        if (/^\d{6,8}$/.test(afterTokens[index]) && /^[A-Z]{2}$/i.test(afterTokens[index + 1])) {
          nameEnd = index;
          break;
        }
      }
      const productName = itemIndex >= 0 ? afterTokens.slice(itemIndex + 2, nameEnd).join(" ") : "";
      const state = nameEnd < afterTokens.length ? afterTokens[nameEnd + 1] : "";
      const cityEnd = afterTokens.findIndex((token, index) => index > nameEnd + 1 && /^\d{5}(?:-\d{4})?$/.test(token));
      const city = cityEnd > nameEnd + 1 ? afterTokens.slice(nameEnd + 2, cityEnd).join(" ") : "";
      const zip = cityEnd > -1 ? afterTokens[cityEnd] : "";
      const reliableCustomerOrder = isReliableOrderIdentifier(customerOrder);
      const reliablePurchaseOrder = isReliableOrderIdentifier(purchaseOrder);
      const po =
        (reliableCustomerOrder ? customerOrder : "") ||
        (reliablePurchaseOrder ? purchaseOrder : "") ||
        (purchaseOrder ? `${purchaseOrder}${purchaseLine ? `-${purchaseLine}` : ""}` : "") ||
        customerOrder ||
        fallbackPo;
      const reliablePo = reliableCustomerOrder || reliablePurchaseOrder;
      const groupKey = reliablePo
        ? po
        : [transactionKey, purchaseLine, gtin, productName].filter(Boolean).join("|");
      const type = transactionKind(startType, description, rawAmountType);
      const chargeLike = /fee|commission|shipping label|wfs|storage|refund|return shipping/i.test(type);
      const amount = toNumber(rawAmount);

      return {
        po_number: po,
        transaction_key: transactionKey,
        group_key: groupKey || po,
        transaction_date: normalizeDate(date),
        transaction_type: type,
        item_id: itemId,
        upc: gtin,
        product_name: productName,
        amount_type: rawAmountType,
        fulfillment_type: /walmart-fulfilled|wfs/i.test(record) ? "Walmart-fulfilled(WFS)" : /seller fulfilled/i.test(record) ? "Seller Fulfilled" : undefined,
        category: "",
        product_type: "",
        location: [city, state, zip].filter(Boolean).join(", "),
        quantity: Number.isNaN(quantity) || quantity < 1 ? 1 : quantity,
        net_payable: Number((chargeLike ? -Math.abs(amount) : amount).toFixed(2)),
        status: rawAmountType,
        raw_text: record,
      };
    });

  return parsed.filter((transaction): transaction is ParsedTransaction => (
    transaction !== null &&
    Boolean(transaction.po_number && transaction.transaction_type && transaction.net_payable !== 0)
  ));
}

function transactionOrderKey(transaction: ParsedTransaction) {
  return (transaction.group_key || transaction.po_number)?.trim();
}

function chooseTransactionGroup(transactions: ParsedTransaction[]) {
  const grouped = new Map<string, ParsedTransaction[]>();
  for (const transaction of transactions) {
    const key = transactionOrderKey(transaction);
    if (!key) continue;
    grouped.set(key, [...(grouped.get(key) ?? []), transaction]);
  }

  const groups = [...grouped.entries()].sort(([, left], [, right]) => right.length - left.length);
  return groups[0] ?? null;
}

function transactionGroups(transactions: ParsedTransaction[]) {
  const grouped = new Map<string, ParsedTransaction[]>();
  for (const transaction of transactions) {
    const key = transactionOrderKey(transaction);
    if (!key) continue;
    grouped.set(key, [...(grouped.get(key) ?? []), transaction]);
  }
  return [...grouped.entries()].sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
}

function firstUsefulProductName(transactions: ParsedTransaction[]) {
  return (
    transactions.find((transaction) => transaction.product_name && !/^\d+$/.test(transaction.product_name))?.product_name ||
    transactions.find((transaction) => transaction.raw_text.match(/[A-Za-z].{12,}/))?.product_name ||
    "Imported Walmart item"
  );
}

function firstUsefulUpc(transactions: ParsedTransaction[]) {
  return (
    transactions.find((transaction) => transaction.upc && /^\d{12,14}$/.test(transaction.upc))?.upc ||
    transactions.find((transaction) => transaction.item_id && /^\d{12,14}$/.test(transaction.item_id))?.item_id ||
    transactions.find((transaction) => transaction.upc)?.upc ||
    transactions.find((transaction) => transaction.item_id)?.item_id ||
    ""
  );
}

function orderFromTransactionGroup(poNumber: string, group: ParsedTransaction[], groupCount: number) {
  const productSales = group.filter((transaction) => {
    const joined = `${transaction.transaction_type} ${transaction.amount_type ?? ""} ${transaction.status ?? ""}`;
    return /sale/i.test(transaction.transaction_type) && /product\s*price|purchase|sale/i.test(joined) && transaction.net_payable > 0;
  });
  const shippingRows = group.filter((transaction) => /shipping label/i.test(transaction.transaction_type));
  const gross = productSales.reduce((sum, transaction) => sum + Number(transaction.net_payable || 0), 0);
  const quantity = Math.max(1, productSales.reduce((sum, transaction) => sum + Number(transaction.quantity || 0), 0) || 1);
  const shipping = shippingRows.reduce((sum, transaction) => sum + Math.abs(Number(transaction.net_payable || 0)), 0);
  const firstTransaction = group[0];
  const productIdentity = group.find((transaction) => transaction.product_name || transaction.upc || transaction.item_id) ?? firstTransaction;

  return {
    groupCount,
    order: {
      po_number: poNumber,
      walmart_order_number: poNumber,
      product_name: firstUsefulProductName(group),
      upc: firstUsefulUpc(group),
      walmart_item_id: productIdentity.item_id,
      quantity,
      unit_price: Number((gross / quantity).toFixed(2)),
      subtotal: Number(gross.toFixed(2)),
      shipping_cost: Number(shipping.toFixed(2)),
      order_date: productSales.find((transaction) => transaction.transaction_date)?.transaction_date || firstTransaction.transaction_date,
      shipping_fee_charged: 0,
      taxes: 0,
      customer_total: Number(gross.toFixed(2)),
      amount_adjusted: 0,
      status: firstTransaction.status || "Imported",
      fulfillment_type: productIdentity.fulfillment_type,
      category: productIdentity.category,
      product_type: productIdentity.product_type,
      location: productIdentity.location,
    },
  };
}

function orderFromTransactionReport(transactions: ParsedTransaction[]): { order: ParsedOrder; groupCount: number } | null {
  const chosen = chooseTransactionGroup(transactions);
  if (!chosen) return null;
  return orderFromTransactionGroup(chosen[0], chosen[1], transactionGroups(transactions).length);
}

function importsFromTransactionReport(transactions: ParsedTransaction[], rawTransactionText: string): ParsedImport[] {
  const groups = transactionGroups(transactions);
  return groups
    .map(([poNumber, group]) => {
      const derived = orderFromTransactionGroup(poNumber, group, groups.length);
      return {
        order: derived.order,
        transactions: group,
        warnings: [
          `Imported ${group.length} transaction report lines for PO/order ${poNumber}.`,
          ...(!derived.order.upc ? ["UPC was not found; inventory matching will need manual correction."] : []),
          ...(!derived.order.subtotal ? ["Product sale proceeds were not found for this order."] : []),
        ],
        raw_order_text: "",
        raw_transaction_text: rawTransactionText,
      };
    })
    .filter((parsed) => parsed.order.po_number);
}

function mergeDerivedOrder(order: ParsedOrder, derived: ParsedOrder): ParsedOrder {
  const merged = { ...order };
  for (const key of Object.keys(derived) as (keyof ParsedOrder)[]) {
    const current = merged[key];
    const next = derived[key];
    const isMissingString = typeof current === "string" && (!current || current === "Unlabeled Walmart item");
    const isMissingNumber = typeof current === "number" && !current;
    if (current === undefined || isMissingString || isMissingNumber) {
      (merged[key] as ParsedOrder[typeof key]) = next;
    }
  }
  return merged;
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
  if (looksLikeSettlementRows(text)) return parseFreeformSettlementRows(transactionText, fallbackPo);
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

function isSettlementReportPaste(text: string) {
  return /transaction\s*type/i.test(text) &&
    /transaction\s*description/i.test(text) &&
    /purchase\s*order/i.test(text) &&
    /amount\s*type/i.test(text);
}

function looksLikeSettlementRows(text: string) {
  return /commission on product|commissi|product tax withheld|product ta|walmart shipping label|wfs fulfillment|product price|product pr/i.test(text) &&
    /\d{4}_\d{2}_\d{2}|\d+(?:\.\d+)?E\+\d+/i.test(text);
}

function hasDelimitedSettlementHeader(text: string) {
  const header = text.replace(/\r/g, "\n").split("\n").find((line) => /transaction\s*type/i.test(line) && /amount/i.test(line));
  return Boolean(header && delimitedCells(header).length >= 8);
}

export function parseWalmartImport(orderText: string, transactionText: string): ParsedImport {
  const orderBoxHasSettlementReport = isSettlementReportPaste(orderText);
  const effectiveOrderText = orderBoxHasSettlementReport ? "" : orderText;
  const effectiveTransactionText =
    transactionText.trim() || (orderBoxHasSettlementReport ? orderText : "");

  let order = parseOrderDetails(effectiveOrderText);
  const transactions = parseTransactions(effectiveTransactionText, order.po_number);
  const derived = transactions.length ? orderFromTransactionReport(transactions) : null;
  if (derived) {
    order = mergeDerivedOrder(order, derived.order);
  }
  const shippingFromTransactions = transactions
    .filter((transaction) => /shipping label/i.test(transaction.transaction_type))
    .reduce((sum, transaction) => sum + Math.abs(transaction.net_payable), 0);
  const warnings: string[] = [];
  const batch =
    derived && derived.groupCount > 1 && !effectiveOrderText.trim()
      ? importsFromTransactionReport(transactions, effectiveTransactionText)
      : undefined;

  if (orderBoxHasSettlementReport) {
    warnings.push("Detected a Walmart settlement report in the order-details box and parsed it as transaction data.");
  }
  if (looksLikeSettlementRows(effectiveTransactionText) && !hasDelimitedSettlementHeader(effectiveTransactionText) && !transactions.length) {
    warnings.push("Settlement rows were detected, but the paste is missing usable spreadsheet columns. Copy the full report rows including the header row from Excel/Sheets so item name, GTIN, order number, amount, and fee columns stay separated.");
  }
  if (derived && derived.groupCount > 1) {
    warnings.push(
      batch
        ? `The transaction report contains ${derived.groupCount} order groups. Confirm and Save will import each order group separately.`
        : `The transaction report contains ${derived.groupCount} order groups. This preview is showing PO/order ${derived.order.po_number}; save imports the lines for that order.`,
    );
  }
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

  return {
    order,
    transactions,
    warnings,
    raw_order_text: effectiveOrderText,
    raw_transaction_text: effectiveTransactionText,
    batch,
  };
}
