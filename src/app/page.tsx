"use client";

import {
  AlertTriangle,
  Archive,
  BarChart3,
  Barcode,
  Boxes,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  ClipboardPaste,
  Crown,
  Database,
  Download,
  Edit3,
  Home as HomeIcon,
  ImageIcon,
  Menu,
  Minus,
  PackagePlus,
  Plus,
  ReceiptText,
  RefreshCw,
  Search,
  Settings,
  ShoppingBag,
  Trash2,
  Truck,
  Users,
  WalletCards,
} from "lucide-react";
import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { clsx } from "clsx";
import Image from "next/image";
import {
  currency,
  dashboardMetrics,
  feeBreakdown,
  orderCogs,
  orderFees,
  orderGross,
  orderMargin,
  orderProfit,
  orderRefunds,
  orderShipping,
  percent,
  profitTrend,
  salesByItem,
} from "@/lib/calculations";
import { demoInventory, demoMovements, demoOrders } from "@/lib/demo-data";
import { parseWalmartImport } from "@/lib/parser";
import {
  deleteOrderRecord,
  deleteAllOrders,
  adjustInventoryQuantity,
  createInventoryItem,
  isSupabaseConfigured,
  loadDashboardData,
  saveParsedImport,
  updateInventoryItem,
  updateOrderRecord,
  type OrderEditInput,
} from "@/lib/supabase";
import type { InventoryItem, InventoryMovement, OrderView, ParsedImport, ParsedOrder } from "@/lib/types";

const views = [
  { id: "dashboard", label: "Dashboard", icon: HomeIcon },
  { id: "import", label: "Settlement Import", icon: ClipboardPaste },
  { id: "orders", label: "Orders / Sales", icon: ShoppingBag },
  { id: "inventory", label: "Inventory", icon: Boxes },
  { id: "reports", label: "Reports", icon: BarChart3 },
  { id: "settings", label: "Settings", icon: Settings },
] as const;

const pieColors = ["#7067ff", "#4fc67a", "#ffb14f", "#f174a6", "#9aa7c7"];

type ViewId = (typeof views)[number]["id"];

function statusClass(status?: string | null) {
  if (/out/i.test(status || "")) return "badge danger";
  if (/need/i.test(status || "")) return "badge warning";
  if (/low/i.test(status || "")) return "badge amber";
  if (/pending/i.test(status || "")) return "badge blue";
  return "badge success";
}

function inputValue(value: unknown) {
  return value === undefined || value === null ? "" : String(value);
}

type ImportPreviewRow = {
  id: string;
  parsed: ParsedImport;
  poNumber: string;
  walmartOrderNumber: string;
  orderDate: string;
  product: string;
  upc: string;
  quantity: number;
  unitPrice: number;
  grossSales: number;
  walmartFees: number;
  shippingCosts: number;
  refunds: number;
  estimatedCogs: number;
  estimatedProfit: number;
  transactionCount: number;
  status: "Ready" | "Needs Cost" | "Missing UPC" | "Warning";
  warnings: string[];
};

type ImportSummary = {
  totalOrders?: number;
  totalTransactions?: number;
  grossSales?: number;
  walmartFees?: number;
  shippingCosts?: number;
  refunds?: number;
  estimatedCogs?: number;
  estimatedProfit?: number;
  dateRange?: string;
  marketplace: string;
  missingCostCount: number;
};

type InventoryImpact = {
  matched: number;
  unknown: number;
  needsCost: number;
  unitsToSubtract: number;
  potentialOutOfStock: number;
  newRecordsNeeded: number;
};

function parsedImports(preview: ParsedImport | null) {
  if (!preview) return [];
  return preview.batch?.length ? preview.batch : [preview];
}

function transactionAmount(imports: ParsedImport[], matcher: (text: string) => boolean) {
  return imports.reduce(
    (sum, parsed) =>
      sum + parsed.transactions.reduce((transactionSum, transaction) => {
        const text = `${transaction.transaction_type} ${transaction.amount_type ?? ""} ${transaction.status ?? ""}`;
        return matcher(text) ? transactionSum + Math.abs(Number(transaction.net_payable || 0)) : transactionSum;
      }, 0),
    0,
  );
}

function findInventoryMatch(order: ParsedOrder, inventory: InventoryItem[]) {
  const identifiers = [
    order.upc,
    order.walmart_item_id,
  ].filter(Boolean).map((value) => String(value).trim().toLowerCase());

  return inventory.find((item) => {
    const candidates = [item.upc, item.partner_gtin, item.sku, item.partner_item_id, item.walmart_item_id]
      .filter(Boolean)
      .map((value) => String(value).trim().toLowerCase());
    return identifiers.some((identifier) => candidates.includes(identifier));
  });
}

function getParsedImportRows(preview: ParsedImport | null, inventory: InventoryItem[]): ImportPreviewRow[] {
  return parsedImports(preview).map((parsed, index) => {
    const order = parsed.order;
    const match = findInventoryMatch(order, inventory);
    const walmartFees = transactionAmount([parsed], (text) => /commission|service fee|referral|wfs|fulfillment|storage|transaction fee|fee\/reimbursement/i.test(text) && !/shipping label|refund|return refund|return shipping/i.test(text));
    const shippingCosts = Number(order.shipping_cost || 0) || transactionAmount([parsed], (text) => /shipping label|shipping cost|shipping/i.test(text) && !/shipping fee charged/i.test(text));
    const refunds = transactionAmount([parsed], (text) => /refund|return/i.test(text));
    const estimatedCogs = Number(match?.unit_cost || 0) * Number(order.quantity || 0);
    const grossSales = Number(order.subtotal || order.customer_total || 0);
    const estimatedProfit = grossSales - walmartFees - shippingCosts - refunds - estimatedCogs;
    const warnings = [
      ...parsed.warnings,
      ...(!order.upc ? ["Missing UPC / GTIN"] : []),
      ...(!match ? ["Inventory item will need review or creation"] : []),
      ...(match && !Number(match.unit_cost) ? ["Matched item needs cost"] : []),
    ];
    const status: ImportPreviewRow["status"] = !order.upc ? "Missing UPC" : match && !Number(match.unit_cost) ? "Needs Cost" : warnings.length ? "Warning" : "Ready";

    return {
      id: `${order.po_number || order.walmart_order_number || "preview"}-${index}`,
      parsed,
      poNumber: order.po_number,
      walmartOrderNumber: order.walmart_order_number,
      orderDate: order.order_date || parsed.transactions.find((transaction) => transaction.transaction_date)?.transaction_date || "",
      product: order.product_name,
      upc: order.upc,
      quantity: Number(order.quantity || 0),
      unitPrice: Number(order.unit_price || 0),
      grossSales,
      walmartFees,
      shippingCosts,
      refunds,
      estimatedCogs,
      estimatedProfit,
      transactionCount: parsed.transactions.length,
      status,
      warnings,
    };
  });
}

function getImportDateRange(rows: ImportPreviewRow[]) {
  const dates = rows.map((row) => row.orderDate).filter(Boolean).sort();
  if (!dates.length) return undefined;
  const first = dates[0];
  const last = dates[dates.length - 1];
  return first === last ? first : `${first} - ${last}`;
}

function getImportSummary(preview: ParsedImport | null, inventory: InventoryItem[]): ImportSummary {
  const imports = parsedImports(preview);
  if (!preview) return { marketplace: "Walmart.com", missingCostCount: 0 };
  const rows = getParsedImportRows(preview, inventory);
  return {
    totalOrders: rows.length,
    totalTransactions: imports.reduce((sum, parsed) => sum + parsed.transactions.length, 0) || rows.length,
    grossSales: rows.reduce((sum, row) => sum + row.grossSales, 0),
    walmartFees: rows.reduce((sum, row) => sum + row.walmartFees, 0),
    shippingCosts: rows.reduce((sum, row) => sum + row.shippingCosts, 0),
    refunds: rows.reduce((sum, row) => sum + row.refunds, 0),
    estimatedCogs: rows.reduce((sum, row) => sum + row.estimatedCogs, 0),
    estimatedProfit: rows.reduce((sum, row) => sum + row.estimatedProfit, 0),
    dateRange: getImportDateRange(rows),
    marketplace: "Walmart.com",
    missingCostCount: rows.filter((row) => row.status === "Needs Cost").length,
  };
}

function getInventoryImpact(preview: ParsedImport | null, inventory: InventoryItem[]): InventoryImpact | null {
  if (!preview) return null;
  const rows = getParsedImportRows(preview, inventory);
  return rows.reduce<InventoryImpact>(
    (impact, row) => {
      const match = findInventoryMatch(row.parsed.order, inventory);
      const quantity = Number(row.quantity || 0);
      impact.unitsToSubtract += quantity;
      if (match) {
        impact.matched += 1;
        if (!Number(match.unit_cost)) impact.needsCost += 1;
        if (Number(match.quantity_on_hand || 0) - quantity < 0 || Number(match.quantity_on_hand || 0) - quantity <= Number(match.reorder_point || 0)) {
          impact.potentialOutOfStock += 1;
        }
      } else {
        impact.unknown += 1;
        impact.newRecordsNeeded += 1;
      }
      return impact;
    },
    { matched: 0, unknown: 0, needsCost: 0, unitsToSubtract: 0, potentialOutOfStock: 0, newRecordsNeeded: 0 },
  );
}

function formatOptionalCurrency(value?: number) {
  return value === undefined ? "-" : currency(value);
}

function getSavedOrderDateRange(orders: OrderView[]) {
  const dates = orders.map((order) => order.order_date).filter(Boolean).sort() as string[];
  if (!dates.length) return "No date range selected";
  return dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} - ${dates[dates.length - 1]}`;
}

export default function Home() {
  const configured = isSupabaseConfigured();
  const [activeView, setActiveView] = useState<ViewId>("dashboard");
  const [orders, setOrders] = useState<OrderView[]>(demoOrders);
  const [inventory, setInventory] = useState<InventoryItem[]>(demoInventory);
  const [movements, setMovements] = useState<InventoryMovement[]>(demoMovements);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [orderText, setOrderText] = useState("");
  const [transactionText, setTransactionText] = useState("");
  const [preview, setPreview] = useState<ParsedImport | null>(null);
  const [saving, setSaving] = useState(false);
  const [importComplete, setImportComplete] = useState(false);

  const refresh = useCallback(async () => {
    if (!configured) {
      setOrders(demoOrders);
      setInventory(demoInventory);
      setMovements(demoMovements);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await loadDashboardData();
      setOrders(data.orders);
      setInventory(data.inventory);
      setMovements(data.movements);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load Supabase data.");
    } finally {
      setLoading(false);
    }
  }, [configured]);

  useEffect(() => {
    if (!configured) return;
    let cancelled = false;
    async function loadInitialData() {
      await Promise.resolve();
      setLoading(true);
      try {
        const data = await loadDashboardData();
        if (cancelled) return;
        setOrders(data.orders);
        setInventory(data.inventory);
        setMovements(data.movements);
        setMessage("");
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "Could not load Supabase data.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadInitialData();
    return () => {
      cancelled = true;
    };
  }, [configured]);

  const metrics = useMemo(() => dashboardMetrics(orders, inventory), [orders, inventory]);
  const trend = useMemo(() => profitTrend(orders, inventory), [orders, inventory]);
  const itemSales = useMemo(() => salesByItem(orders, inventory), [orders, inventory]);
  const fees = useMemo(() => feeBreakdown(orders), [orders]);
  const recentOrders = orders.slice(0, 5);
  const needsCost = inventory.filter((item) => item.needs_cost || !Number(item.unit_cost));

  const parsePreview = () => {
    const parsed = parseWalmartImport(orderText, transactionText);
    setPreview(parsed);
    setImportComplete(false);
    const batchMessage = parsed.batch?.length ? ` ${parsed.batch.length} orders are ready for batch save.` : "";
    setMessage(parsed.warnings.length ? `${parsed.warnings.join(" ")}${batchMessage}` : `Preview parsed.${batchMessage} Review fields, then save.`);
  };

  const parseUploadedSettlementFile = (fileName: string, fileText: string) => {
    setTransactionText(fileText);
    setOrderText("");
    const parsed = parseWalmartImport("", fileText);
    setPreview(parsed);
    setImportComplete(false);
    const importsToSave = parsed.batch?.length ? parsed.batch.length : 1;
    const transactionCount = parsed.batch?.length
      ? parsed.batch.reduce((sum, item) => sum + item.transactions.length, 0)
      : parsed.transactions.length;
    const warningText = parsed.warnings.length ? ` ${parsed.warnings.join(" ")}` : "";
    setMessage(`Parsed ${fileName}: ${importsToSave} order group(s), ${transactionCount} transaction line(s).${warningText}`);
  };

  const updatePreviewOrder = (key: keyof ParsedOrder, value: string) => {
    if (!preview) return;
    const numericKeys = new Set(["quantity", "unit_price", "subtotal", "shipping_cost", "shipping_fee_charged", "taxes", "customer_total", "amount_adjusted"]);
    const nextValue = numericKeys.has(key) ? Number(value) : value;
    const nextOrder = {
      ...preview.order,
      [key]: nextValue,
    };
    if (key === "subtotal") {
      nextOrder.customer_total = Number(value);
      nextOrder.taxes = 0;
    }
    setPreview({
      ...preview,
      order: nextOrder,
    });
  };

  const savePreview = async () => {
    if (!preview) return;
    if (!configured) {
      setMessage("Demo Mode is active. Add Supabase env vars to enable persistent saving.");
      return;
    }
    setSaving(true);
    try {
      const importsToSave = preview.batch?.length ? preview.batch : [preview];
      for (const parsedImport of importsToSave) {
        await saveParsedImport(parsedImport);
      }
      setMessage(
        importsToSave.length > 1
          ? `Saved ${importsToSave.length} Walmart order groups to Supabase and refreshed the dashboard.`
          : `Saved PO ${preview.order.po_number} to Supabase and refreshed the dashboard.`,
      );
      setPreview(null);
      await refresh();
      setImportComplete(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const updateCost = async (item: InventoryItem, value: string, supplier?: string) => {
    const unitCost = Number(value);
    if (Number.isNaN(unitCost) || unitCost < 0) {
      setMessage("Cost Each must be a valid zero-or-higher number.");
      return;
    }
    if (!configured) {
      setInventory((current) =>
        current.map((candidate) =>
          candidate.id === item.id ? { ...candidate, unit_cost: unitCost, needs_cost: !unitCost, supplier: supplier?.trim() || candidate.supplier } : candidate,
        ),
      );
      setMessage("Demo Mode cost updated locally for preview. Supabase is required for persistence.");
      return;
    }
    try {
      const updated = await updateInventoryItem(item.id, { unit_cost: unitCost, ...(supplier?.trim() ? { supplier: supplier.trim() } : {}) });
      if (updated) {
        setInventory((current) => current.map((candidate) => candidate.id === updated.id ? updated : candidate));
      }
      await refresh();
      setMessage(`Updated Cost Each for ${item.product_name}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Updating Cost Each failed.");
    }
  };

  const editOrder = async (order: OrderView, input: OrderEditInput) => {
    if (!configured) {
      setOrders((current) =>
        current.map((candidate) =>
          candidate.id === order.id
            ? {
                ...candidate,
                po_number: input.po_number,
                walmart_order_number: input.walmart_order_number,
                order_date: input.order_date,
                customer_name: input.customer_name,
                status: input.status,
                subtotal: input.subtotal,
                taxes: 0,
                customer_total: input.subtotal,
                items: [
                  {
                    ...candidate.items[0],
                    upc: input.upc,
                    product_name: input.product_name,
                    walmart_item_id: input.walmart_item_id,
                    quantity: input.quantity,
                    unit_price: input.unit_price,
                    subtotal: input.subtotal,
                  },
                ],
                fees: input.walmart_fee
                  ? [{ ...candidate.fees[0], amount: Math.abs(input.walmart_fee), fee_type: "Walmart Service Fee" }]
                  : [],
                shipments: [{ ...candidate.shipments[0], shipping_cost: input.shipping_cost, shipping_status: input.status }],
              }
            : candidate,
        ),
      );
      setMessage("Demo Mode order updated locally for preview. Supabase is required for persistence.");
      return;
    }
    await updateOrderRecord(order, input);
    await refresh();
    setMessage(`Updated PO ${input.po_number}.`);
  };

  const deleteOrder = async (order: OrderView) => {
    if (!window.confirm(`Delete PO ${order.po_number}? This will restore the sold quantity to inventory.`)) return;
    if (!configured) {
      setOrders((current) => current.filter((candidate) => candidate.id !== order.id));
      setMessage("Demo Mode order deleted locally for preview. Supabase is required for persistence.");
      return;
    }
    await deleteOrderRecord(order);
    await refresh();
    setMessage(`Deleted PO ${order.po_number} and restored inventory quantity.`);
  };

  const deleteEveryOrder = async () => {
    if (!window.confirm("Delete ALL orders? This will remove every order and restore sold quantities to inventory.")) return;
    if (!configured) {
      const count = orders.length;
      setOrders([]);
      setMessage(`Demo Mode deleted ${count} orders locally.`);
      return;
    }
    setSaving(true);
    try {
      const deleted = await deleteAllOrders();
      await refresh();
      setMessage(`Deleted ${deleted} orders and restored inventory quantities.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Deleting all orders failed.");
    } finally {
      setSaving(false);
    }
  };

  const mainTitle = views.find((view) => view.id === activeView)?.label ?? "Dashboard";
  const topbarDateLabel = activeView === "import"
    ? getImportSummary(preview, inventory).dateRange ?? getSavedOrderDateRange(orders)
    : "May 1 - May 15, 2026";

  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="portal-brand">
            <Crown size={28} />
            <div>
              <strong>Cherolee Portal</strong>
              <span>Settlement Management</span>
            </div>
          </div>
          <Menu size={17} />
        </div>

        <nav className="side-nav">
          {views.map((view) => {
            const Icon = view.icon;
            return (
              <button
                key={view.id}
                className={clsx("nav-item", activeView === view.id && "active")}
                onClick={() => setActiveView(view.id)}
              >
                <Icon size={17} />
                <span>{view.label}</span>
              </button>
            );
          })}
          <button className="nav-item">
            <Users size={17} />
            <span>Customers</span>
          </button>
        </nav>

        <div className="sidebar-block">
          <p>Quick actions</p>
          <button className="quick-action" onClick={() => setActiveView("import")}>
            <PackagePlus size={16} />
            Add Inventory Item
          </button>
          <button className="quick-action" onClick={() => setActiveView("inventory")}>
            <ClipboardPaste size={16} />
            Import Inventory
          </button>
          <button className="quick-action" onClick={() => setActiveView("reports")}>
            <Download size={16} />
            Export Inventory
          </button>
        </div>

        <div className="sidebar-block">
          <p>Alerts</p>
          <div className="alert-row"><AlertTriangle size={15} /> Needs attention <strong>{metrics.needsCost}</strong></div>
          <div className="alert-row red"><AlertTriangle size={15} /> Low stock items <strong>{metrics.lowStock}</strong></div>
          <div className="alert-row blue"><RefreshCw size={15} /> Pending transactions <strong>{metrics.pendingTransactions}</strong></div>
        </div>

        <div className="account">
          <div className="avatar">C</div>
          <div>
            <strong>Cherolee LLC</strong>
            <span>Seller Account</span>
          </div>
          <ChevronDown size={16} />
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h1>{mainTitle === "Dashboard" ? "Dashboard Overview" : mainTitle}</h1>
            <p>
              {activeView === "inventory"
                ? "Search, scan, add, remove, and review item performance."
                : activeView === "import"
                  ? "Import Walmart sales, fees, refunds, shipping, and inventory-impacting order data."
                  : "Track Walmart sales, fees, costs and profit."}
            </p>
          </div>
          <div className="top-actions">
            {!configured && <span className="demo-pill"><Database size={14} /> Demo Mode</span>}
            <button className="filter-button"><CalendarDays size={15} /> {topbarDateLabel}</button>
            {activeView === "import" ? <button className="filter-button" onClick={() => setMessage("Import history is not available yet.")}>View History</button> : <button className="filter-button">Compare</button>}
            <button className="export-button"><Download size={15} /> {activeView === "inventory" ? "Export Inventory" : activeView === "import" ? "Download Template" : "Export Report"}</button>
          </div>
        </header>

        {message && <div className="message">{message}</div>}
        {loading ? <div className="loading-card">Loading Supabase dashboard data...</div> : null}

        {activeView === "dashboard" && (
          <DashboardView
            metrics={metrics}
            trend={trend}
            itemSales={itemSales}
            fees={fees}
            recentOrders={recentOrders}
            inventory={inventory}
            needsCost={needsCost}
          />
        )}

        {activeView === "import" && (
          <ImportView
            orderText={orderText}
            transactionText={transactionText}
            setOrderText={setOrderText}
            setTransactionText={setTransactionText}
            preview={preview}
            parsePreview={parsePreview}
            savePreview={savePreview}
            saving={saving}
            updatePreviewOrder={updatePreviewOrder}
            inventory={inventory}
            importComplete={importComplete}
            setMessage={setMessage}
            parseUploadedSettlementFile={parseUploadedSettlementFile}
          />
        )}

        {activeView === "orders" && (
          <OrdersView orders={orders} inventory={inventory} onEditOrder={editOrder} onDeleteOrder={deleteOrder} onDeleteAllOrders={deleteEveryOrder} />
        )}
        {activeView === "inventory" && (
          <InventoryView
            configured={configured}
            inventory={inventory}
            orders={orders}
            movements={movements}
            updateCost={updateCost}
            refresh={refresh}
            setInventory={setInventory}
            setMovements={setMovements}
            setMessage={setMessage}
          />
        )}
        {activeView === "reports" && <ReportsView orders={orders} inventory={inventory} itemSales={itemSales} fees={fees} />}
        {activeView === "settings" && <SettingsView configured={configured} />}
      </main>
    </div>
  );
}

function DashboardView({
  metrics,
  trend,
  itemSales,
  fees,
  recentOrders,
  inventory,
  needsCost,
}: {
  metrics: ReturnType<typeof dashboardMetrics>;
  trend: ReturnType<typeof profitTrend>;
  itemSales: ReturnType<typeof salesByItem>;
  fees: ReturnType<typeof feeBreakdown>;
  recentOrders: OrderView[];
  inventory: InventoryItem[];
  needsCost: InventoryItem[];
}) {
  const cards = [
    { label: "Gross Revenue", value: currency(metrics.grossRevenue), icon: CircleDollarSign, tone: "green", delta: "12.4%" },
    { label: "Net Profit", value: currency(metrics.netProfit), icon: WalletCards, tone: "green", delta: "18.7%" },
    { label: "Total Fees", value: currency(metrics.walmartFees), icon: ReceiptText, tone: "red", delta: "2.9%" },
    { label: "Shipping Costs", value: currency(metrics.shippingCosts), icon: Truck, tone: "blue", delta: "6.1%" },
    { label: "COGS", value: currency(metrics.totalCogs), icon: Archive, tone: "purple", delta: "10.3%" },
    { label: "Units Sold", value: String(metrics.unitsSold), icon: Boxes, tone: "teal", delta: "15.8%" },
    { label: "Orders", value: String(metrics.ordersCount), icon: ShoppingBag, tone: "orange", delta: "14.7%" },
  ];

  return (
    <div className="content-grid">
      <section className="kpi-grid">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <article className="kpi-card" key={card.label}>
              <div className={clsx("kpi-icon", card.tone)}><Icon size={18} /></div>
              <div>
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>↗ {card.delta} vs Apr 16-Apr 30</small>
              </div>
            </article>
          );
        })}
      </section>

      <section className="chart-card wide">
        <div className="card-heading">
          <h2>Profit Trend</h2>
          <button className="tiny-button">Daily</button>
        </div>
        <ResponsiveContainer width="100%" height={210}>
          <AreaChart data={trend}>
            <CartesianGrid strokeDasharray="3 3" stroke="#edf0f7" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} tickFormatter={(value) => `$${value}`} />
            <Tooltip formatter={(value) => currency(Number(value))} />
            <Area type="monotone" dataKey="gross" stroke="#6965ff" fill="#6965ff22" strokeWidth={2} name="Gross Revenue" />
            <Area type="monotone" dataKey="profit" stroke="#2dbf6d" fill="#2dbf6d20" strokeWidth={2} name="Net Profit" />
          </AreaChart>
        </ResponsiveContainer>
      </section>

      <section className="chart-card">
        <div className="card-heading"><h2>Sales by Item (Top 5)</h2></div>
        <ResponsiveContainer width="100%" height={210}>
          <PieChart>
            <Pie data={itemSales.slice(0, 5)} dataKey="sales" nameKey="name" innerRadius={48} outerRadius={78}>
              {itemSales.slice(0, 5).map((entry, index) => <Cell key={entry.name} fill={pieColors[index % pieColors.length]} />)}
            </Pie>
            <Tooltip formatter={(value) => currency(Number(value))} />
          </PieChart>
        </ResponsiveContainer>
      </section>

      <section className="chart-card">
        <div className="card-heading"><h2>Fee Breakdown</h2></div>
        <ResponsiveContainer width="100%" height={210}>
          <PieChart>
            <Pie data={fees.length ? fees : [{ name: "No fees", value: 1 }]} dataKey="value" nameKey="name" innerRadius={48} outerRadius={78}>
              {(fees.length ? fees : [{ name: "No fees", value: 1 }]).map((entry, index) => <Cell key={entry.name} fill={pieColors[index % pieColors.length]} />)}
            </Pie>
            <Tooltip formatter={(value) => currency(Number(value))} />
          </PieChart>
        </ResponsiveContainer>
      </section>

      <OrdersTable orders={recentOrders} inventory={inventory} compact />
      <InventorySnapshot inventory={inventory.slice(0, 5)} />
      <ProfitSummary metrics={metrics} />
      <TopItems itemSales={itemSales} />
      <NeedsCostTable items={needsCost} />
    </div>
  );
}

function ImportView(props: {
  orderText: string;
  transactionText: string;
  setOrderText: (value: string) => void;
  setTransactionText: (value: string) => void;
  preview: ParsedImport | null;
  parsePreview: () => void;
  savePreview: () => void;
  saving: boolean;
  updatePreviewOrder: (key: keyof ParsedOrder, value: string) => void;
  inventory: InventoryItem[];
  importComplete: boolean;
  setMessage: (value: string) => void;
  parseUploadedSettlementFile: (fileName: string, fileText: string) => void;
}) {
  const [previewSearch, setPreviewSearch] = useState("");
  const [selectedFile, setSelectedFile] = useState<{ name: string; size: number } | null>(null);
  const [fileError, setFileError] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const fields: { key: keyof ParsedOrder; label: string; type?: string }[] = [
    { key: "po_number", label: "PO number" },
    { key: "walmart_order_number", label: "Walmart order" },
    { key: "product_name", label: "Product title" },
    { key: "upc", label: "UPC" },
    { key: "quantity", label: "Quantity", type: "number" },
    { key: "unit_price", label: "Unit price", type: "number" },
    { key: "subtotal", label: "Seller proceeds", type: "number" },
    { key: "shipping_cost", label: "Shipping label cost", type: "number" },
    { key: "shipping_fee_charged", label: "Customer shipping paid", type: "number" },
    { key: "customer_name", label: "Customer" },
    { key: "status", label: "Status" },
  ];
  const rows = getParsedImportRows(props.preview, props.inventory);
  const summary = getImportSummary(props.preview, props.inventory);
  const impact = getInventoryImpact(props.preview, props.inventory);
  const hasWarnings = Boolean(props.preview?.warnings.length || rows.some((row) => row.status !== "Ready"));
  const activeStep = props.saving ? "Save" : props.importComplete ? "Complete" : hasWarnings ? "Validate" : props.preview ? "Preview" : "Input";
  const transactionRows = props.preview?.batch?.length ? props.preview.batch[0]?.transactions ?? [] : props.preview?.transactions ?? [];
  const filteredRows = rows.filter((row) => {
    const query = previewSearch.trim().toLowerCase();
    if (!query) return true;
    return [row.poNumber, row.walmartOrderNumber, row.product, row.upc, row.status].some((value) => value.toLowerCase().includes(query));
  });
  const validationChecks = [
    {
      label: "Order details parsed",
      state: props.preview ? "success" : "muted",
      detail: props.preview ? `${rows.length || 1} parsed order group${(rows.length || 1) === 1 ? "" : "s"}` : "Waiting for paste input",
    },
    {
      label: "Transaction details parsed",
      state: props.preview ? ((summary.totalTransactions ?? 0) > 0 ? "success" : "warning") : "muted",
      detail: props.preview ? `${summary.totalTransactions ?? 0} transaction line${(summary.totalTransactions ?? 0) === 1 ? "" : "s"}` : "No transaction data parsed yet",
    },
    {
      label: "Required identifiers found",
      state: props.preview ? (rows.every((row) => row.poNumber || row.walmartOrderNumber) ? "success" : "warning") : "muted",
      detail: props.preview ? `${rows.filter((row) => row.poNumber || row.walmartOrderNumber).length} of ${rows.length} rows have order identifiers` : "PO/order numbers are checked after parsing",
    },
    {
      label: "UPC / GTIN coverage",
      state: props.preview ? (rows.every((row) => row.upc) ? "success" : "warning") : "muted",
      detail: props.preview ? `${rows.filter((row) => row.upc).length} of ${rows.length} rows have UPC/GTIN` : "UPC matching is checked after parsing",
    },
    {
      label: "Cost coverage",
      state: props.preview ? (summary.missingCostCount ? "warning" : "success") : "muted",
      detail: props.preview ? (summary.missingCostCount ? `${summary.missingCostCount} matched item${summary.missingCostCount === 1 ? "" : "s"} need cost` : "Matched item costs are available") : "COGS is checked after parsing",
    },
    {
      label: "Rows ready to save",
      state: props.preview && rows.length ? "success" : "muted",
      detail: props.preview && rows.length ? `${rows.length} row${rows.length === 1 ? "" : "s"} ready for Confirm and Save` : "Parse preview before saving",
    },
  ] as const;
  const stepOrder = ["Input", "Validate", "Preview", "Save", "Complete"];
  const activeIndex = stepOrder.indexOf(activeStep);
  const tips = [
    ["Use complete Walmart order details", "Include PO number, order number, item name, UPC/GTIN, quantity, and proceeds when available."],
    ["Paste transaction details when available", "Fees, refunds, adjustments, and shipping costs improve profit accuracy."],
    ["Review missing costs", "Items without unit cost will be marked Needs Cost and profit may be incomplete."],
    ["Check inventory impact before saving", "Imported sales reduce inventory quantities for matched items."],
    ["Avoid duplicate imports", "Duplicate PO or order numbers should be detected before save."],
  ];
  const handleSettlementFile = async (file: File | undefined) => {
    if (!file) return;
    setFileError("");
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!["csv", "tsv", "txt"].includes(extension)) {
      setSelectedFile(null);
      setFileError("Use a CSV, TSV, or TXT export. XLSX parsing is not enabled yet.");
      props.setMessage("File import rejected: upload a CSV, TSV, or TXT Walmart settlement export.");
      return;
    }
    try {
      const fileText = await file.text();
      if (!fileText.trim()) {
        setSelectedFile(null);
        setFileError("That file is empty.");
        props.setMessage("File import failed: the selected file is empty.");
        return;
      }
      setSelectedFile({ name: file.name, size: file.size });
      props.parseUploadedSettlementFile(file.name, fileText);
    } catch (error) {
      setSelectedFile(null);
      setFileError(error instanceof Error ? error.message : "Could not read the selected file.");
      props.setMessage(error instanceof Error ? error.message : "Could not read the selected file.");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <section className="settlement-page">
      <div className="settlement-stepper-card">
        <div className="settlement-stepper">
          {stepOrder.map((step, index) => {
            const complete = index < activeIndex || (props.importComplete && step !== "Complete");
            const warning = step === "Validate" && hasWarnings && props.preview;
            return (
              <div
                key={step}
                className={clsx(
                  "settlement-step",
                  activeStep === step && "settlement-step-active",
                  complete && "settlement-step-complete",
                  warning && "settlement-step-warning",
                )}
              >
                <span className="settlement-step-number">{complete ? <CheckCircle2 size={15} /> : warning ? <AlertTriangle size={15} /> : index + 1}</span>
                <strong>{step}</strong>
                <small>{["Paste or upload data", "Check required fields", "Review parsed rows", "Create records", "Dashboard updated"][index]}</small>
              </div>
            );
          })}
        </div>
      </div>

      <div className="settlement-workbench">
        <div className="settlement-top-row">
          <section className="settlement-card file-import-card">
            <div>
              <h2>Upload Settlement File</h2>
              <p>Upload a real Walmart CSV, TSV, or TXT settlement export. It feeds the same preview and save flow as manual paste.</p>
            </div>
            <input
              ref={fileInputRef}
              className="file-input"
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
              onChange={(event) => void handleSettlementFile(event.target.files?.[0])}
            />
            <button className="file-import-dropzone" type="button" onClick={() => fileInputRef.current?.click()}>
              <Archive size={30} />
              <strong>{selectedFile ? selectedFile.name : "Choose settlement file"}</strong>
              <span>{selectedFile ? `${Math.max(1, Math.round(selectedFile.size / 1024))} KB parsed from an actual uploaded file` : "CSV, TSV, or TXT. XLSX is rejected until real workbook parsing is added."}</span>
            </button>
            {fileError && <div className="file-error">{fileError}</div>}
          </section>

          <section className="settlement-card import-status-card">
            <div className="settlement-card-heading">
              <div>
                <h2>Validation Results</h2>
                <p>{props.preview ? "Validation reflects the current parsed preview." : "Paste Walmart order details or transactions to begin."}</p>
              </div>
              <span className={clsx("status-badge", props.preview ? (hasWarnings ? "status-warning" : "status-success") : "status-muted")}>
                {props.preview ? (hasWarnings ? "Needs review" : "Ready") : "Waiting"}
              </span>
            </div>
            {validationChecks.map((check) => (
              <div className="import-check-row" key={check.label}>
                <span className={clsx("check-dot", `check-${check.state}`)}>{check.state === "success" ? <CheckCircle2 size={14} /> : check.state === "warning" ? <AlertTriangle size={14} /> : "-"}</span>
                <div>
                  <strong>{check.label}</strong>
                  <small>{check.detail}</small>
                </div>
              </div>
            ))}
          </section>

          <section className="settlement-card import-summary-card">
            <h2>Import Summary</h2>
            <p>Overview of the import data</p>
            {[
              ["Total Parsed Orders", summary.totalOrders ?? "-"],
              ["Total Parsed Transactions", summary.totalTransactions ?? "-"],
              ["Gross Sales", formatOptionalCurrency(summary.grossSales)],
              ["Walmart Fees", formatOptionalCurrency(summary.walmartFees)],
              ["Shipping Costs", formatOptionalCurrency(summary.shippingCosts)],
              ["Refunds / Returns", formatOptionalCurrency(summary.refunds)],
              ["Estimated COGS", formatOptionalCurrency(summary.estimatedCogs)],
              ["Estimated Profit", formatOptionalCurrency(summary.estimatedProfit)],
              ["Date Range", summary.dateRange ?? "-"],
              ["Marketplace", summary.marketplace],
            ].map(([label, value]) => (
              <div className={clsx("summary-row", label === "Estimated Profit" && "summary-total")} key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
            {summary.missingCostCount > 0 && <div className="info-box warning">Profit estimate incomplete: some items need cost.</div>}
          </section>
        </div>

        <div className="settlement-main-column">
          <section className="settlement-card manual-paste-card">
            <div className="settlement-card-heading">
              <div>
                <h2>Manual Paste Import</h2>
                <p>Paste Walmart order details and transaction details to calculate sales, fees, shipping, refunds, profit, and inventory impact.</p>
              </div>
            </div>
            <div className="manual-paste-grid">
              <label>
                <span>Walmart Order Details Paste</span>
                <textarea value={props.orderText} onChange={(event) => props.setOrderText(event.target.value)} />
              </label>
              <label>
                <span>Walmart Transactions Paste</span>
                <textarea
                  value={props.transactionText}
                  placeholder="Optional. Leave blank to auto-calculate Walmart commission at 15%."
                  onChange={(event) => props.setTransactionText(event.target.value)}
                />
              </label>
            </div>
            <div className="manual-paste-actions">
              <button className="export-button" onClick={props.parsePreview}><Search size={16} /> Parse Preview</button>
              <button className="filter-button" onClick={props.savePreview} disabled={!props.preview || props.saving}>
                <CheckCircle2 size={16} /> {props.saving ? "Saving..." : props.preview?.batch?.length ? `Save ${props.preview.batch.length} Orders` : "Confirm and Save"}
              </button>
            </div>
          </section>

          {props.preview && !props.preview.batch?.length && (
            <section className="settlement-card editable-preview-card">
              <div className="settlement-card-heading">
                <div>
                  <h2>Editable Parse Preview</h2>
                  <p>Correct parsed fields before saving. Summary and profit estimates update from these values.</p>
                </div>
                <span className="status-badge status-muted">Duplicate detection: PO number</span>
              </div>
              <div className="preview-grid">
                {fields.map((field) => (
                  <label key={field.key}>
                    <span>{field.label}</span>
                    <input
                      type={field.type ?? "text"}
                      value={inputValue(props.preview?.order[field.key])}
                      onChange={(event) => props.updatePreviewOrder(field.key, event.target.value)}
                    />
                  </label>
                ))}
              </div>
            </section>
          )}

          <div className="settlement-bottom-row">
          <section className="settlement-card preview-card">
            <div className="preview-toolbar">
              <div>
                <h2>Data Preview</h2>
                <p>Review parsed Walmart order, fee, shipping, refund, and profit data before saving.</p>
              </div>
              <div className="preview-toolbar-actions">
                <div className="preview-search">
                  <Search size={15} />
                  <input value={previewSearch} onChange={(event) => setPreviewSearch(event.target.value)} placeholder="Search preview..." />
                </div>
                <button className="filter-button" onClick={() => props.setMessage("Preview export coming soon.")}><Download size={15} /> Export Preview</button>
              </div>
            </div>
            {filteredRows.length ? (
              <div className="preview-table">
                <table>
                  <thead>
                    <tr>
                      <th>PO Number</th>
                      <th>Walmart Order #</th>
                      <th>Order Date</th>
                      <th>Product</th>
                      <th>UPC / GTIN</th>
                      <th>Qty</th>
                      <th>Unit Price</th>
                      <th>Gross / Proceeds</th>
                      <th>Walmart Fees</th>
                      <th>Shipping</th>
                      <th>Refunds</th>
                      <th>Estimated COGS</th>
                      <th>Estimated Profit</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map((row) => (
                      <tr key={row.id}>
                        <td>{row.poNumber || "-"}</td>
                        <td>{row.walmartOrderNumber || "-"}</td>
                        <td>{row.orderDate || "-"}</td>
                        <td className="product-cell">{row.product || "-"}</td>
                        <td>{row.upc || "-"}</td>
                        <td>{row.quantity}</td>
                        <td>{currency(row.unitPrice)}</td>
                        <td>{currency(row.grossSales)}</td>
                        <td>{currency(row.walmartFees)}</td>
                        <td>{currency(row.shippingCosts)}</td>
                        <td>{currency(row.refunds)}</td>
                        <td>{currency(row.estimatedCogs)}</td>
                        <td className={row.estimatedProfit < 0 ? "profit-negative" : "profit-positive"}>{currency(row.estimatedProfit)}</td>
                        <td><span className={clsx("status-badge", row.status === "Ready" ? "status-success" : row.status === "Missing UPC" ? "status-danger" : "status-warning")}>{row.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="preview-empty">No settlement data loaded yet. Paste Walmart order details or transaction details, then click Parse Preview.</div>
            )}
            {props.preview && (
              <div className="transaction-preview">
                <h3>{props.preview.batch?.length ? `Transactions for first order group (${props.preview.batch[0]?.order.po_number})` : "Transactions"}</h3>
                {transactionRows.map((transaction, index) => (
                  <div key={`${transaction.transaction_type}-${index}`}>
                    <span>{transaction.transaction_type}</span>
                    <strong>{currency(transaction.net_payable)}</strong>
                    <em>{transaction.status || "Parsed"}</em>
                  </div>
                ))}
                {!transactionRows.length && <p>No transaction lines found for this preview.</p>}
              </div>
            )}
          </section>

          <aside className="settlement-side-column">
          <section className="settlement-card inventory-impact-card">
            <h2>Inventory Impact</h2>
            {impact ? (
              [
                ["Items matched to inventory", impact.matched],
                ["Unknown UPC / GTIN", impact.unknown],
                ["Items needing cost", impact.needsCost],
                ["Units to subtract from inventory", impact.unitsToSubtract],
                ["Potential out-of-stock items", impact.potentialOutOfStock],
                ["New inventory records needed", impact.newRecordsNeeded],
              ].map(([label, value]) => (
                <div className="impact-row" key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))
            ) : (
              <div className="preview-empty compact">No inventory impact calculated yet.</div>
            )}
          </section>

          <section className="settlement-card tips-card">
            <h2>Import Tips</h2>
            {tips.map(([title, detail], index) => (
              <div className="tip-row" key={title}>
                <span>{index + 1}</span>
                <div>
                  <strong>{title}</strong>
                  <small>{detail}</small>
                </div>
              </div>
            ))}
            <button className="tiny-button" onClick={() => props.setMessage("Documentation is not available yet.")}>View Documentation</button>
          </section>
          </aside>
          </div>
        </div>
      </div>
    </section>
  );
}

function orderToEditInput(order: OrderView): OrderEditInput {
  const item = order.items[0];
  return {
    po_number: order.po_number,
    walmart_order_number: order.walmart_order_number || "",
    order_date: order.order_date || "",
    customer_name: order.customer_name || "",
    status: order.status || "Parsed",
    product_name: item?.product_name || "",
    upc: item?.upc || "",
    walmart_item_id: item?.walmart_item_id || "",
    quantity: item?.quantity || 1,
    unit_price: item?.unit_price || 0,
    subtotal: item?.subtotal || order.subtotal || 0,
    taxes: 0,
    customer_total: item?.subtotal || order.subtotal || order.customer_total || 0,
    shipping_cost: orderShipping(order),
    walmart_fee: orderFees(order),
  };
}

function OrdersView({
  orders,
  inventory,
  onEditOrder,
  onDeleteOrder,
  onDeleteAllOrders,
}: {
  orders: OrderView[];
  inventory: InventoryItem[];
  onEditOrder: (order: OrderView, input: OrderEditInput) => Promise<void>;
  onDeleteOrder: (order: OrderView) => Promise<void>;
  onDeleteAllOrders: () => Promise<void>;
}) {
  const [editingOrder, setEditingOrder] = useState<OrderView | null>(null);
  const [draft, setDraft] = useState<OrderEditInput | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  const startEdit = (order: OrderView) => {
    setEditingOrder(order);
    setDraft(orderToEditInput(order));
  };

  const updateDraft = (key: keyof OrderEditInput, value: string) => {
    if (!draft) return;
    const numeric = new Set(["quantity", "unit_price", "subtotal", "customer_total", "shipping_cost", "walmart_fee"]);
    const nextDraft = {
      ...draft,
      [key]: numeric.has(key) ? Number(value) : value,
    };
    if (key === "quantity" || key === "unit_price") {
      nextDraft.subtotal = Number((Number(nextDraft.quantity || 0) * Number(nextDraft.unit_price || 0)).toFixed(2));
      nextDraft.customer_total = nextDraft.subtotal;
    }
    if (key === "subtotal") {
      nextDraft.customer_total = Number(nextDraft.subtotal || 0);
      nextDraft.taxes = 0;
    }
    setDraft(nextDraft);
  };

  const saveEdit = async () => {
    if (!editingOrder || !draft) return;
    setSavingEdit(true);
    try {
      await onEditOrder(editingOrder, draft);
      setEditingOrder(null);
      setDraft(null);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Order update failed.");
    } finally {
      setSavingEdit(false);
    }
  };

  return (
    <div className="page-stack">
      <section className="orders-toolbar">
        <div>
          <strong>{orders.length} orders</strong>
          <span>Delete bad imports in one action.</span>
        </div>
        <button className="danger-button" onClick={() => void onDeleteAllOrders()}>
          <Trash2 size={16} /> Delete All Orders
        </button>
      </section>
      <OrdersTable orders={orders} inventory={inventory} onEdit={startEdit} onDelete={onDeleteOrder} />
      {editingOrder && draft && (
        <section className="preview-card">
          <div className="card-heading">
            <h2>Edit PO {editingOrder.po_number}</h2>
            <button className="tiny-button" onClick={() => setEditingOrder(null)}>Close</button>
          </div>
          <div className="preview-grid">
            {[
              ["po_number", "PO number"],
              ["walmart_order_number", "Walmart order"],
              ["order_date", "Order date", "date"],
              ["customer_name", "Customer"],
              ["status", "Status"],
              ["product_name", "Product title"],
              ["upc", "UPC"],
              ["walmart_item_id", "Item ID"],
              ["quantity", "Quantity", "number"],
              ["unit_price", "Unit price", "number"],
              ["subtotal", "Seller proceeds", "number"],
              ["walmart_fee", "Walmart fee", "number"],
              ["shipping_cost", "Shipping label cost", "number"],
            ].map(([key, label, type]) => (
              <label key={key}>
                <span>{label}</span>
                <input
                  type={type || "text"}
                  value={inputValue(draft[key as keyof OrderEditInput])}
                  onChange={(event) => updateDraft(key as keyof OrderEditInput, event.target.value)}
                />
              </label>
            ))}
          </div>
          <div className="edit-actions">
            <button className="export-button" onClick={saveEdit} disabled={savingEdit}>
              <CheckCircle2 size={16} /> {savingEdit ? "Saving..." : "Save Changes"}
            </button>
            <button
              className="danger-button"
              onClick={() => void onDeleteOrder(editingOrder).then(() => setEditingOrder(null)).catch((error) => {
                window.alert(error instanceof Error ? error.message : "Order delete failed.");
              })}
            >
              <Trash2 size={16} /> Delete Order
            </button>
          </div>
        </section>
      )}
      {orders[0] && (
        <section className="chart-card">
          <div className="card-heading"><h2>Transparent Profit Formula</h2></div>
          <div className="formula">
            <strong>PO {orders[0].po_number}</strong>
            <span>Profit = gross item sales - Walmart fees - shipping cost - COGS</span>
            <p>
              {currency(orderProfit(orders[0], inventory))} = {currency(orderGross(orders[0]))} - {currency(orderFees(orders[0]))} - {currency(orderShipping(orders[0]))} - {currency(orderCogs(orders[0], inventory))} - {currency(orderRefunds(orders[0]))}
            </p>
            <small>Margin: {percent(orderMargin(orders[0], inventory))}</small>
          </div>
        </section>
      )}
    </div>
  );
}

function itemOrderBreakdown(order: OrderView, upc: string, inventory: InventoryItem[]) {
  const item = order.items.find((candidate) => candidate.upc === upc);
  if (!item) return null;
  const orderGrossValue = orderGross(order);
  const itemGross = Number(item.subtotal || 0);
  const share = orderGrossValue ? itemGross / orderGrossValue : 1;
  const fees = orderFees(order) * share;
  const shipping = orderShipping(order) * share;
  const unitCost = Number(inventory.find((inventoryItem) => inventoryItem.upc === upc)?.unit_cost ?? item.unit_cost ?? 0);
  const cogs = unitCost * Number(item.quantity || 0);
  const refunds = order.transactions.filter((transaction) => /refund|return shipping/i.test(transaction.transaction_type || transaction.status || ""));
  const refundTotal = refunds.reduce((sum, transaction) => sum + Math.abs(Number(transaction.net_payable || 0)), 0);
  const profit = itemGross - fees - shipping - cogs - refundTotal;

  return {
    order,
    item,
    itemGross,
    fees,
    shipping,
    cogs,
    refundTotal,
    profit,
    refunds,
  };
}

function inventoryStats(item: InventoryItem, orders: OrderView[], inventory: InventoryItem[]) {
  const rows = orders
    .map((order) => itemOrderBreakdown(order, item.upc, inventory))
    .filter(Boolean) as NonNullable<ReturnType<typeof itemOrderBreakdown>>[];
  return {
    rows,
    unitsSold: rows.reduce((sum, row) => sum + Number(row.item.quantity || 0), 0),
    gross: rows.reduce((sum, row) => sum + row.itemGross, 0),
    fees: rows.reduce((sum, row) => sum + row.fees, 0),
    shipping: rows.reduce((sum, row) => sum + row.shipping, 0),
    cogs: rows.reduce((sum, row) => sum + row.cogs, 0),
    refunds: rows.reduce((sum, row) => sum + row.refundTotal, 0),
    profit: rows.reduce((sum, row) => sum + row.profit, 0),
  };
}

type ScanMode = "scan" | "add" | "remove";
type RemoveReason = "Gifted" | "Kept" | "Damaged" | "Other";

function normalizeLookup(value: string) {
  const trimmed = value.trim().replace(/[\s-]/g, "");
  if (!/[eE]\+/.test(trimmed)) return trimmed.toLowerCase();
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed.toLocaleString("en-US", { maximumFractionDigits: 0, useGrouping: false }).toLowerCase() : trimmed.toLowerCase();
}

function itemMatches(item: InventoryItem, query: string) {
  const lookup = normalizeLookup(query);
  const haystack = [
    item.product_name,
    item.upc,
    item.sku,
    item.partner_item_id,
    item.partner_gtin,
    item.walmart_item_id,
  ].filter(Boolean).map((value) => normalizeLookup(String(value)));
  return haystack.some((value) => value.includes(lookup));
}

function formatDateTime(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function itemStatus(item: InventoryItem) {
  if (item.needs_cost || !Number(item.unit_cost)) return "Needs Cost";
  if (item.quantity_on_hand <= 0) return "Out of Stock";
  if (item.quantity_on_hand <= item.reorder_point) return "Low Stock";
  return "In Stock";
}

function feeSplit(order: OrderView) {
  const commission = order.fees
    .filter((fee) => /commission|service|referral|walmart/i.test(fee.fee_type) && !/wfs/i.test(fee.fee_type))
    .reduce((sum, fee) => sum + Math.abs(Number(fee.amount || 0)), 0);
  const wfs = order.fees.filter((fee) => /wfs|fulfillment|storage|inventory/i.test(fee.fee_type)).reduce((sum, fee) => sum + Math.abs(Number(fee.amount || 0)), 0);
  return { commission, wfs, shipping: orderShipping(order), other: Math.max(0, orderFees(order) - commission - wfs) };
}

function InventoryView({
  configured,
  inventory,
  orders,
  movements,
  updateCost,
  refresh,
  setInventory,
  setMovements,
  setMessage,
}: {
  configured: boolean;
  inventory: InventoryItem[];
  orders: OrderView[];
  movements: InventoryMovement[];
  updateCost: (item: InventoryItem, value: string, supplier?: string) => void;
  refresh: () => Promise<void>;
  setInventory: Dispatch<SetStateAction<InventoryItem[]>>;
  setMovements: Dispatch<SetStateAction<InventoryMovement[]>>;
  setMessage: Dispatch<SetStateAction<string>>;
}) {
  const [selectedItemId, setSelectedItemId] = useState(inventory[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [scanMode, setScanMode] = useState<ScanMode>("scan");
  const [removeReason, setRemoveReason] = useState<RemoveReason | "">("");
  const [addQty, setAddQty] = useState(1);
  const [removeQty, setRemoveQty] = useState(1);
  const [typeFilter, setTypeFilter] = useState("All");
  const [stockRange, setStockRange] = useState("30 Days");
  const [missingLookup, setMissingLookup] = useState("");
  const [newItemName, setNewItemName] = useState("");
  const [creatingItem, setCreatingItem] = useState(false);
  const [purchaseDate, setPurchaseDate] = useState(new Date().toISOString().slice(0, 10));
  const [purchaseSource, setPurchaseSource] = useState("");
  const [addUnitCost, setAddUnitCost] = useState("");
  const [costDraft, setCostDraft] = useState("");
  const [costDraftItemId, setCostDraftItemId] = useState("");

  const selectedItem = missingLookup ? null : inventory.find((item) => item.id === selectedItemId) ?? inventory[0] ?? null;
  const selectedStats = selectedItem ? inventoryStats(selectedItem, orders, inventory) : null;
  const searchResults = query.trim() ? inventory.filter((item) => itemMatches(item, query)) : [];
  const itemMovements = selectedItem ? movements.filter((movement) => movement.inventory_item_id === selectedItem.id) : [];
  const itemOrders = selectedItem && selectedStats ? selectedStats.rows : [];
  const feeTotals = itemOrders.reduce(
    (totals, row) => {
      const split = feeSplit(row.order);
      return {
        commission: totals.commission + split.commission,
        wfs: totals.wfs + split.wfs,
        shipping: totals.shipping + split.shipping,
        other: totals.other + split.other,
      };
    },
    { commission: 0, wfs: 0, shipping: 0, other: 0 },
  );
  const transactionRows = itemOrders.flatMap((row) => {
    const split = feeSplit(row.order);
    const base = {
      date: row.order.order_date || row.order.created_at || "",
      orderNumber: row.order.walmart_order_number || "-",
      po: row.order.po_number,
      qty: row.item.quantity,
      unitPrice: row.item.unit_price,
      commission: split.commission,
      shipping: split.shipping,
      wfs: split.wfs,
      refund: row.refundTotal,
      profit: row.profit,
      status: row.order.status || "Shipped",
    };
    const lines = [{ ...base, type: "Sale" }];
    for (const refund of row.refunds) {
      lines.push({ ...base, date: refund.transaction_date || base.date, type: /return/i.test(refund.transaction_type) ? "Return" : "Refund", qty: -Math.abs(Number(refund.quantity || 1)), unitPrice: 0, commission: 0, shipping: 0, wfs: 0, refund: Math.abs(Number(refund.net_payable || 0)), profit: -Math.abs(Number(refund.net_payable || 0)), status: "Refunded" });
    }
    return lines;
  }).filter((row) => typeFilter === "All" || row.type === typeFilter);
  const qtySold = selectedStats?.unitsSold ?? 0;
  const returns = itemOrders.reduce((sum, row) => sum + row.refunds.reduce((count, transaction) => count + Math.abs(Number(transaction.quantity || 1)), 0), 0);
  const avgSellingPrice = qtySold ? (selectedStats?.gross ?? 0) / qtySold : 0;
  const profitMargin = selectedStats?.gross ? ((selectedStats.profit / selectedStats.gross) * 100) : 0;
  const sellThrough = qtySold + Number(selectedItem?.quantity_on_hand || 0) ? (qtySold / (qtySold + Number(selectedItem?.quantity_on_hand || 0))) * 100 : 0;
  const stockTrend = [...itemMovements].reverse().reduce<{ date: string; qty: number }[]>((rows, movement) => {
    const previous = rows.at(-1)?.qty ?? Number(selectedItem?.quantity_on_hand || 0);
    rows.push({ date: movement.created_at?.slice(5, 10) || "Now", qty: Math.max(0, previous + Number(movement.quantity_change || 0)) });
    return rows;
  }, [{ date: "Start", qty: Math.max(0, Number(selectedItem?.quantity_on_hand || 0) - itemMovements.reduce((sum, movement) => sum + Number(movement.quantity_change || 0), 0)) }]).slice(stockRange === "7 Days" ? -7 : stockRange === "90 Days" || stockRange === "All Time" ? undefined : -30);

  const visibleCostDraft = selectedItem && costDraftItemId === selectedItem.id ? costDraft : String(selectedItem?.unit_cost || "");

  const saveCostOfGoods = async () => {
    if (!selectedItem) return;
    await updateCost(selectedItem, visibleCostDraft || "0", purchaseSource);
  };

  const selectFirstMatch = async (raw: string, mode = scanMode) => {
    const lookup = normalizeLookup(raw);
    if (!lookup) return;
    const matches = inventory.filter((item) => itemMatches(item, lookup));
    if (matches.length === 1) {
      setMissingLookup("");
      setNewItemName("");
      setSelectedItemId(matches[0].id);
      if (mode === "add") await adjustItem(matches[0], "add", 1, true);
      if (mode === "remove") await adjustItem(matches[0], "remove", 1, true);
      if (mode === "scan") setMessage(`Opened ${matches[0].product_name}.`);
      return;
    }
    if (matches.length > 1) {
      setMissingLookup("");
      setMessage(`${matches.length} matching inventory items found. Choose one from the results.`);
      return;
    }
    setMissingLookup(lookup);
    setNewItemName("");
    setSelectedItemId("");
    setMessage(`Item not found for UPC ${lookup}. Create the inventory item first.`);
  };

  const adjustItem = async (item: InventoryItem, direction: "add" | "remove", quantity: number, scan = false) => {
    if (direction === "remove" && !removeReason) {
      setMessage("Please select a removal reason.");
      return;
    }
    const unitCost = addUnitCost === "" ? undefined : Number(addUnitCost);
    if (direction === "add" && unitCost !== undefined && Number.isNaN(unitCost)) {
      setMessage("Cost each must be a valid number.");
      return;
    }
    try {
      if (!configured) {
        const quantityChange = direction === "add" ? quantity : -quantity;
        setInventory((current) =>
          current.map((candidate) =>
            candidate.id === item.id
              ? {
                  ...candidate,
                  quantity_on_hand: Math.max(0, candidate.quantity_on_hand + quantityChange),
                  unit_cost: direction === "add" && unitCost !== undefined ? unitCost : candidate.unit_cost,
                  supplier: direction === "add" && purchaseSource.trim() ? purchaseSource.trim() : candidate.supplier,
                  needs_cost: direction === "add" && unitCost !== undefined ? !Number(unitCost) : candidate.needs_cost,
                  last_scanned_at: scan ? new Date().toISOString() : candidate.last_scanned_at,
                }
              : candidate,
          ),
        );
        setMovements((current) => [
          {
            id: `demo-movement-${Date.now()}`,
            inventory_item_id: item.id,
            movement_type: direction === "add" ? (scan ? "scan_add" : "manual_add") : scan ? "scan_remove" : "manual_remove",
            quantity_change: quantityChange,
            reason: direction === "add" ? (scan ? "Added by scan" : "Manual add") : (removeReason as RemoveReason),
            source: scan ? "Barcode Scan" : "Admin",
            supplier: purchaseSource || null,
            purchase_date: purchaseDate || null,
            created_by: "Admin",
            created_at: new Date().toISOString(),
          },
          ...current,
        ]);
        setMessage(direction === "add" ? `Added ${quantity} unit${quantity === 1 ? "" : "s"} to inventory.` : `Removed ${quantity} unit${quantity === 1 ? "" : "s"} from inventory.`);
        return;
      }
      const reason = direction === "add" ? (scan ? "Added by scan" : "Manual add") : (removeReason as RemoveReason);
      const updated = await adjustInventoryQuantity({
        item,
        quantity,
        direction,
        reason,
        scan,
        unitCost: direction === "add" ? unitCost : undefined,
        supplier: direction === "add" ? purchaseSource : undefined,
        purchaseDate: direction === "add" ? purchaseDate : undefined,
      });
      if (updated) {
        setInventory((current) => current.map((candidate) => candidate.id === updated.id ? updated : candidate));
        setSelectedItemId(updated.id);
      }
      await refresh();
      setMessage(direction === "add" ? `Added ${quantity} unit${quantity === 1 ? "" : "s"} to inventory.` : `Removed ${quantity} unit${quantity === 1 ? "" : "s"} from inventory.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Inventory adjustment failed.");
    }
  };

  const createMissingItem = async () => {
    const lookup = missingLookup || normalizeLookup(query);
    if (!lookup) return;
    setCreatingItem(true);
    try {
      if (!configured) {
        const now = new Date().toISOString();
        const created: InventoryItem = {
          id: `demo-inv-${Date.now()}`,
          upc: lookup,
          partner_gtin: lookup,
          product_name: newItemName.trim() || `New item ${lookup}`,
          marketplace: "Walmart",
          quantity_on_hand: 0,
          unit_cost: 0,
          reorder_point: 0,
          needs_cost: true,
          fulfillment_type: "Seller Fulfilled",
          created_at: now,
          updated_at: now,
          last_scanned_at: now,
        };
        setInventory((current) => [created, ...current]);
        setSelectedItemId(created.id);
        setMissingLookup("");
        setNewItemName("");
        setQuery(lookup);
        setMessage("Created demo inventory item. Supabase is required for persistence.");
        return;
      }
      const created = await createInventoryItem({ upc: lookup, product_name: newItemName });
      setInventory((current) => [created, ...current.filter((item) => item.id !== created.id && item.upc !== created.upc)]);
      setSelectedItemId(created.id);
      setMissingLookup("");
      setNewItemName("");
      setQuery(created.upc);
      setMessage(`Created inventory item for ${created.upc}.`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Creating inventory item failed.");
    } finally {
      setCreatingItem(false);
    }
  };

  if (!selectedItem || !selectedStats) {
    return (
      <div className="inventory-control-page">
        <section className="inventory-toolbar">
          <div className="scan-search">
            <Search size={18} />
            <input
              value={query}
              placeholder="Search by name or scan/type UPC"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void selectFirstMatch(query);
              }}
            />
            <Barcode size={20} />
          </div>
          <button className={clsx("scan-mode-button add", scanMode === "add" && "active")} onClick={() => setScanMode("add")}>
            <Plus size={18} /><span>Add Inventory<small>Adds 1 per scan</small></span>
          </button>
          <button className={clsx("scan-mode-button remove", scanMode === "remove" && "active")} onClick={() => setScanMode("remove")}>
            <Minus size={18} /><span>Remove Inventory<small>Requires reason if not a sale</small></span>
          </button>
          <button className={clsx("scan-mode-button scan", scanMode === "scan" && "active")} onClick={() => setScanMode("scan")}>
            <Barcode size={18} /><span>Scan Item<small>View item details</small></span>
          </button>
        </section>
        <section className="missing-item-card">
          <div className="product-image"><Barcode size={34} /></div>
          <div>
            <span>Item not found</span>
            <h2>{missingLookup || normalizeLookup(query) || "New scanned item"}</h2>
            <p>Create this UPC/GTIN before adding or removing inventory. The item will be marked Needs Cost until you add unit cost.</p>
          </div>
          <label>
            Product name
            <input value={newItemName} placeholder="Optional product name" onChange={(event) => setNewItemName(event.target.value)} />
          </label>
          <button className="export-button" onClick={createMissingItem} disabled={creatingItem}>
            <Plus size={15} /> {creatingItem ? "Creating..." : "Create Inventory Item"}
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className="inventory-control-page">
      <section className="inventory-toolbar">
        <div className="scan-search">
          <Search size={18} />
          <input
            value={query}
            placeholder="Search by name or scan/type UPC"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void selectFirstMatch(query);
            }}
          />
          <Barcode size={20} />
        </div>
        <button className={clsx("scan-mode-button add", scanMode === "add" && "active")} onClick={() => setScanMode("add")}>
          <Plus size={18} /><span>Add Inventory<small>Adds 1 per scan</small></span>
        </button>
        <button className={clsx("scan-mode-button remove", scanMode === "remove" && "active")} onClick={() => setScanMode("remove")}>
          <Minus size={18} /><span>Remove Inventory<small>Requires reason if not a sale</small></span>
        </button>
        <button className={clsx("scan-mode-button scan", scanMode === "scan" && "active")} onClick={() => setScanMode("scan")}>
          <Barcode size={18} /><span>Scan Item<small>View item details</small></span>
        </button>
        {scanMode === "remove" && (
          <div className="remove-reason-card">
            <strong>Remove Reason</strong>
            <span>(when not from a sale)</span>
            <div>{(["Gifted", "Kept", "Damaged", "Other"] as RemoveReason[]).map((reason) => <button className={clsx(removeReason === reason && "active")} key={reason} onClick={() => setRemoveReason(reason)}>{reason}</button>)}</div>
          </div>
        )}
      </section>

      {query.trim() && (
        <section className="search-results-card">
          <strong>{searchResults.length ? "Matching Results" : "Item not found"}</strong>
          {searchResults.map((item) => <button key={item.id} onClick={() => { setMissingLookup(""); setSelectedItemId(item.id); }}>{item.product_name}<span>{item.upc}</span></button>)}
          {!searchResults.length && (
            <button className="export-button" onClick={createMissingItem} disabled={creatingItem}>
              <Plus size={15} /> {creatingItem ? "Creating..." : "Create Inventory Item"}
            </button>
          )}
        </section>
      )}

      <section className="selected-item-card">
        <div className="product-image">{selectedItem.product_image_url ? <Image src={selectedItem.product_image_url} alt="" width={76} height={76} unoptimized /> : <ImageIcon size={34} />}</div>
        <div className="selected-item-title"><h2>{selectedItem.product_name}</h2><span>UPC <button title="Copy UPC" onClick={() => navigator.clipboard.writeText(selectedItem.upc)}>{selectedItem.upc}</button></span></div>
        <div><span>SKU / Partner Item ID</span><strong>{selectedItem.sku || selectedItem.partner_item_id || selectedItem.walmart_item_id || "-"}</strong></div>
        <div><span>Fulfillment</span><strong>{selectedItem.fulfillment_type || "Seller Fulfilled"}</strong></div>
        <div><span>Location / City</span><strong>{selectedItem.location || "-"}</strong></div>
        <div><span>Last Scanned</span><strong>{formatDateTime(selectedItem.last_scanned_at)}</strong></div>
        <div><span>Status</span><strong><span className={statusClass(itemStatus(selectedItem))}>{itemStatus(selectedItem)}</span></strong></div>
      </section>

      <section className="cogs-editor-card">
        <div>
          <span>Cost of Goods</span>
          <h2>Set Cost Each for this item</h2>
          <p>This updates COGS, profit, item reports, dashboard totals, and clears Needs Cost when greater than zero.</p>
        </div>
        <label>
          Cost each
          <input
            type="number"
            min="0"
            step="0.01"
            value={visibleCostDraft}
            placeholder="0.00"
            onChange={(event) => {
              setCostDraftItemId(selectedItem.id);
              setCostDraft(event.target.value);
            }}
          />
        </label>
        <label>
          Supplier / purchased from
          <input value={purchaseSource} placeholder="Supplier / store" onChange={(event) => setPurchaseSource(event.target.value)} />
        </label>
        <small>Purchase date is recorded when you use Add Inventory below.</small>
        <button className="export-button" onClick={() => void saveCostOfGoods()}>
          <CheckCircle2 size={16} /> Save Cost
        </button>
      </section>

      <section className="item-kpi-row">
        <ReportCard title="Qty On Hand" value={String(selectedItem.quantity_on_hand)} detail="Updated just now" />
        <ReportCard title="Cost Each" value={currency(selectedItem.unit_cost)} detail="Avg landed cost" />
        <ReportCard title="Total Cost" value={currency(selectedItem.quantity_on_hand * selectedItem.unit_cost)} detail="Qty On Hand x Cost Each" />
        <ReportCard title="Qty Sold" value={String(qtySold)} detail="All time" />
        <ReportCard title="Returns" value={String(returns)} detail="All time" />
        <ReportCard title="Sales" value={currency(selectedStats.gross)} detail="All time revenue" />
        <ReportCard title="Profit" value={currency(selectedStats.profit)} detail="All time profit" />
      </section>

      <div className="inventory-detail-grid">
        <div className="inventory-main-column">
          <section className="inventory-panel product-summary-panel">
            <div className="card-heading"><h2>Product Summary</h2><select value={stockRange} onChange={(event) => setStockRange(event.target.value)}><option>7 Days</option><option>30 Days</option><option>90 Days</option><option>All Time</option></select></div>
            <div className="product-summary-grid">
              <div className="product-image large">{selectedItem.product_image_url ? <Image src={selectedItem.product_image_url} alt="" width={92} height={112} unoptimized /> : <ImageIcon size={42} />}</div>
              <div className="product-facts">
                <span>Brand <strong>{selectedItem.brand || "-"}</strong></span>
                <span>Category <strong>{selectedItem.category || "-"}</strong></span>
                <span>Marketplace ID <strong>{selectedItem.walmart_item_id || selectedItem.partner_item_id || "-"}</strong></span>
                <span>Created <strong>{formatDateTime(selectedItem.created_at)}</strong></span>
                <span>Supplier <strong>{selectedItem.supplier || "-"}</strong></span>
                <span>Notes <strong>{selectedItem.notes || "-"}</strong></span>
              </div>
              <div className="stock-trend">
                <strong>Stock Trend (Qty On Hand)</strong>
                <ResponsiveContainer width="100%" height={150}>
                  <AreaChart data={stockTrend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#edf0f7" />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip />
                    <Area type="monotone" dataKey="qty" stroke="#7067ff" fill="#7067ff22" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="quantity-controls">
              <div className="stock-adjust-card">
                <div className="stepper-row">
                  <button onClick={() => setAddQty(Math.max(1, addQty - 1))}><Minus size={15} /></button>
                  <label>Add Qty<input type="number" value={addQty} onChange={(event) => setAddQty(Math.max(1, Number(event.target.value)))} /></label>
                  <button onClick={() => setAddQty(addQty + 1)}><Plus size={15} /></button>
                </div>
                <div className="purchase-fields">
                  <label>Cost each<input type="number" min="0" step="0.01" value={addUnitCost} placeholder={String(selectedItem.unit_cost || 0)} onChange={(event) => setAddUnitCost(event.target.value)} /></label>
                  <label>Purchased date<input type="date" value={purchaseDate} onChange={(event) => setPurchaseDate(event.target.value)} /></label>
                  <label>Purchased from<input value={purchaseSource} placeholder="Supplier / store" onChange={(event) => setPurchaseSource(event.target.value)} /></label>
                </div>
                <small>Adds inventory and can update cost, supplier, and purchase date.</small>
                <button className="export-button" onClick={() => adjustItem(selectedItem, "add", addQty)}>Add Inventory</button>
              </div>
              <div className="stock-adjust-card">
                <div className="stepper-row">
                  <button onClick={() => setRemoveQty(Math.max(1, removeQty - 1))}><Minus size={15} /></button>
                  <label>Remove Qty<input type="number" value={removeQty} onChange={(event) => setRemoveQty(Math.max(1, Number(event.target.value)))} /></label>
                  <button onClick={() => setRemoveQty(removeQty + 1)}><Plus size={15} /></button>
                </div>
                <div className="inline-reason-pills">
                  {(["Gifted", "Kept", "Damaged", "Other"] as RemoveReason[]).map((reason) => (
                    <button type="button" className={clsx(removeReason === reason && "active")} key={reason} onClick={() => setRemoveReason(reason)}>
                      {reason}
                    </button>
                  ))}
                </div>
                <small>Decreases inventory. Reason required if not from sale.</small>
                <button className="danger-button" onClick={() => adjustItem(selectedItem, "remove", removeQty)}>Remove Inventory</button>
              </div>
            </div>
          </section>

          <section className="inventory-panel performance-panel">
            <div className="card-heading"><h2>Sales & Performance</h2></div>
            <div className="performance-metrics">
              <ReportCard title="Revenue" value={currency(selectedStats.gross)} detail="Tax ignored" />
              <ReportCard title="Profit" value={currency(selectedStats.profit)} detail="After fees, shipping, COGS, returns" />
              <ReportCard title="Sell-Through" value={percent(sellThrough)} detail="Units sold vs stock handled" />
              <ReportCard title="Avg Selling Price" value={currency(avgSellingPrice)} detail="Gross sales / units sold" />
              <ReportCard title="Avg Profit Margin" value={percent(profitMargin)} detail="Profit / gross sales" />
              <ReportCard title="Total Fees" value={currency(selectedStats.fees)} detail="Commission, WFS, other fees" />
              <ReportCard title="Total COGS" value={currency(selectedStats.cogs)} detail="Current unit cost basis" />
            </div>
            <div className="breakdown-row">
              <strong>Performance Breakdown</strong>
              <ResponsiveContainer width="100%" height={190}>
                <PieChart><Pie data={[{ name: "WFS fees", value: feeTotals.wfs }, { name: "Referral fees / commission", value: feeTotals.commission }, { name: "Shipping label", value: feeTotals.shipping }, { name: "Other fees", value: feeTotals.other }]} dataKey="value" nameKey="name" innerRadius={45} outerRadius={72}>{pieColors.map((color) => <Cell key={color} fill={color} />)}</Pie><Tooltip formatter={(value) => currency(Number(value))} /></PieChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="inventory-panel history-panel">
            <div className="card-heading"><h2>Order & Transaction History (Line-by-Line)</h2><select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option>All</option><option>Sale</option><option>Refund</option><option>Return</option><option>Fee</option></select></div>
            <table><thead><tr><th>Date</th><th>Order #</th><th>PO #</th><th>Type</th><th>Qty</th><th>Unit Price</th><th>Commission</th><th>Shipping Label</th><th>WFS Fee</th><th>Refund</th><th>Profit</th><th>Status</th></tr></thead><tbody>
              {transactionRows.slice(0, 8).map((row, index) => <tr key={`${row.po}-${row.type}-${index}`}><td>{row.date}</td><td>{row.orderNumber}</td><td>{row.po}</td><td><span className={statusClass(row.type)}>{row.type}</span></td><td>{row.qty}</td><td>{row.unitPrice ? currency(row.unitPrice) : "-"}</td><td>{row.commission ? currency(row.commission) : "-"}</td><td>{row.shipping ? currency(row.shipping) : "-"}</td><td>{row.wfs ? currency(row.wfs) : "-"}</td><td>{row.refund ? currency(row.refund) : "-"}</td><td className={row.profit >= 0 ? "profit-positive" : "profit-negative"}>{currency(row.profit)}</td><td><span className={statusClass(row.status)}>{row.status}</span></td></tr>)}
              {!transactionRows.length && <tr><td colSpan={12}>No sales, refunds, returns, or fee lines found for this item yet.</td></tr>}
            </tbody></table>
            <div className="table-footer">Showing 1 to {Math.min(8, transactionRows.length)} of {transactionRows.length} transactions <button>View all transactions</button></div>
          </section>

          <section className="inventory-panel movement-panel">
            <div className="card-heading"><h2>Inventory Movement History</h2></div>
            <table><thead><tr><th>Date</th><th>Action</th><th>Qty Change</th><th>Reason</th><th>User / Source</th></tr></thead><tbody>
              {itemMovements.slice(0, 8).map((movement) => <tr key={movement.id}><td>{formatDateTime(movement.created_at)}</td><td>{movement.movement_type.replace(/_/g, " ")}</td><td className={movement.quantity_change >= 0 ? "profit-positive" : "profit-negative"}>{movement.quantity_change > 0 ? "+" : ""}{movement.quantity_change}</td><td>{movement.reason}</td><td>{movement.source || movement.created_by || "Admin"}</td></tr>)}
              {!itemMovements.length && <tr><td colSpan={5}>No inventory movement history yet.</td></tr>}
            </tbody></table>
            <div className="table-footer">Showing 1 to {Math.min(8, itemMovements.length)} of {itemMovements.length} movements <button>View all movements</button></div>
          </section>
        </div>

        <aside className="inventory-side-column">
          <section className="inventory-panel health-card"><h2>Inventory Health</h2><div className={clsx("health-warning", itemStatus(selectedItem) !== "In Stock" && "active")}><AlertTriangle size={18} /><strong>{itemStatus(selectedItem) === "In Stock" ? "Healthy Stock" : `${itemStatus(selectedItem)} Warning`}</strong><p>{selectedItem.quantity_on_hand <= selectedItem.reorder_point ? "This item is getting low. Consider restocking soon." : "Inventory is currently healthy."}</p><hr /><span>Reorder Recommendation:</span><strong>25-30 units</strong><p>to maintain healthy stock</p></div></section>
          <section className="inventory-panel profitability-card"><h2>Item Profitability</h2><div className="report-line"><span>Profit per Unit</span><strong>{currency(qtySold ? selectedStats.profit / qtySold : 0)}</strong></div><div className="report-line"><span>Profit Margin</span><strong>{percent(profitMargin)}</strong></div><button className="link-button">View full profitability report</button></section>
          <section className="inventory-panel activity-card"><h2>Item Activity</h2><div className="report-line"><span>Last Scanned</span><strong>{formatDateTime(selectedItem.last_scanned_at)}</strong></div><div className="report-line"><span>Last Manual Update</span><strong>{formatDateTime(itemMovements.find((movement) => /manual|correction/i.test(movement.movement_type))?.created_at)}</strong></div><div className="report-line"><span>First Added</span><strong>{formatDateTime(selectedItem.created_at)}</strong></div><div className="report-line"><span>Last Sold</span><strong>{formatDateTime(itemOrders[0]?.order.order_date)}</strong></div><div className="report-line"><span>Last Returned</span><strong>{formatDateTime(transactionRows.find((row) => /refund|return/i.test(row.type))?.date)}</strong></div></section>
        </aside>
      </div>
      <div className="inventory-helper-note">How it works: Add Inventory increases quantity by 1 for each scan. Remove Inventory decreases quantity by 1 and requires a reason when not tied to a sale. Scan Item opens the item detail view.</div>
    </div>
  );
}

function ReportsView({ orders, inventory, itemSales, fees }: { orders: OrderView[]; inventory: InventoryItem[]; itemSales: ReturnType<typeof salesByItem>; fees: ReturnType<typeof feeBreakdown> }) {
  const lowStock = inventory.filter((item) => item.quantity_on_hand <= item.reorder_point);
  const inventoryValue = inventory.reduce((sum, item) => sum + item.quantity_on_hand * item.unit_cost, 0);
  return (
    <div className="reports-grid">
      <ReportCard title="Profit by Date Range" value={currency(orders.reduce((sum, order) => sum + orderProfit(order, inventory), 0))} detail="May 1 - May 15, 2026" />
      <ReportCard title="Inventory Value" value={currency(inventoryValue)} detail="On-hand quantity times unit cost" />
      <ReportCard title="Items Missing Cost" value={String(inventory.filter((item) => item.needs_cost || !item.unit_cost).length)} detail="Update costs to refresh profit" />
      <ReportCard title="Low Stock" value={String(lowStock.length)} detail="At or below reorder point" />
      <section className="chart-card wide">
        <div className="card-heading"><h2>Sales by Item</h2><button className="tiny-button">Export CSV</button></div>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={itemSales.slice(0, 8)}>
            <CartesianGrid strokeDasharray="3 3" stroke="#edf0f7" />
            <XAxis dataKey="name" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip formatter={(value) => currency(Number(value))} />
            <Bar dataKey="sales" fill="#7067ff" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </section>
      <section className="chart-card">
        <div className="card-heading"><h2>Fees by Order</h2></div>
        {fees.map((fee) => <div className="report-line" key={fee.name}><span>{fee.name}</span><strong>{currency(fee.value)}</strong></div>)}
      </section>
    </div>
  );
}

function SettingsView({ configured }: { configured: boolean }) {
  return (
    <section className="settings-card">
      <div className="card-heading"><h2>Supabase Settings</h2></div>
      <div className="setting-row"><span>NEXT_PUBLIC_SUPABASE_URL</span><strong>{configured ? "Configured" : "Missing"}</strong></div>
      <div className="setting-row"><span>NEXT_PUBLIC_SUPABASE_ANON_KEY</span><strong>{configured ? "Configured" : "Missing"}</strong></div>
      <p>Run `supabase/schema.sql`, optionally run `supabase/seed.sql`, then add these values to `.env.local` and restart the dev server.</p>
    </section>
  );
}

function OrdersTable({
  orders,
  inventory,
  compact = false,
  onEdit,
  onDelete,
}: {
  orders: OrderView[];
  inventory: InventoryItem[];
  compact?: boolean;
  onEdit?: (order: OrderView) => void;
  onDelete?: (order: OrderView) => Promise<void>;
}) {
  const [selectedOrder, setSelectedOrder] = useState<OrderView | null>(null);
  const lastFour = (value?: string | null) => {
    const digits = (value || "").replace(/\D/g, "");
    return digits ? digits.slice(-4) : "----";
  };
  const firstItem = (order: OrderView) => order.items[0];
  const commissionTotal = (order: OrderView) =>
    order.fees
      .filter((fee) => /commission|service|referral/i.test(fee.fee_type || ""))
      .reduce((sum, fee) => sum + Math.abs(Number(fee.amount || 0)), 0);
  const wfsFeeTotal = (order: OrderView) =>
    order.fees
      .filter((fee) => /wfs|fulfillment/i.test(fee.fee_type || ""))
      .reduce((sum, fee) => sum + Math.abs(Number(fee.amount || 0)), 0);
  const shippingOrWfs = (order: OrderView) => {
    const shipping = orderShipping(order);
    return shipping || wfsFeeTotal(order);
  };

  return (
    <section className={clsx("table-card", compact && "wide")}>
      <div className="card-heading"><h2>Recent Orders</h2><button className="tiny-button">View All</button></div>
      <table className="orders-accounting-table">
        <thead><tr><th>Order Date</th><th>Order #</th><th>Item Name</th><th>Sales Price</th><th>Shipping / WFS</th><th>Commission</th><th>Cost of Goods</th><th>Profit</th>{(onEdit || onDelete) && <th>Actions</th>}</tr></thead>
        <tbody>
          {orders.map((order) => {
            const item = firstItem(order);
            return (
            <tr key={order.id} className="clickable-order-row" onClick={() => setSelectedOrder(order)}>
              <td>{order.order_date || order.created_at?.slice(0, 10) || "-"}</td>
              <td><span className="order-last-four">#{lastFour(order.walmart_order_number || order.po_number)}</span></td>
              <td className="order-item-name">{item?.product_name || "Unknown item"}</td>
              <td>{currency(orderGross(order))}</td>
              <td>{currency(shippingOrWfs(order))}</td>
              <td>{currency(commissionTotal(order))}</td>
              <td>{currency(orderCogs(order, inventory))}</td>
              <td className={orderProfit(order, inventory) >= 0 ? "profit-positive" : "profit-negative"}>{currency(orderProfit(order, inventory))}</td>
              {(onEdit || onDelete) && (
                <td onClick={(event) => event.stopPropagation()}>
                  <div className="row-actions">
                    {onEdit && (
                      <button className="row-action-button" onClick={() => onEdit(order)} title="Edit order">
                        <Edit3 size={14} /> Edit
                      </button>
                    )}
                    {onDelete && (
                      <button
                        className="row-action-button danger"
                        onClick={() => void onDelete(order).catch((error) => {
                          window.alert(error instanceof Error ? error.message : "Order delete failed.");
                        })}
                        title="Delete order"
                      >
                        <Trash2 size={14} /> Delete
                      </button>
                    )}
                  </div>
                </td>
              )}
            </tr>
            );
          })}
        </tbody>
      </table>
      {selectedOrder && (
        <div className="order-detail-drawer">
          <div className="card-heading">
            <h3>Order Details #{lastFour(selectedOrder.walmart_order_number || selectedOrder.po_number)}</h3>
            <button className="tiny-button" onClick={() => setSelectedOrder(null)}>Close</button>
          </div>
          <div className="order-detail-grid">
            <span>Buyer <strong>{selectedOrder.customer_name || "Not captured"}</strong></span>
            <span>Full order # <strong>{selectedOrder.walmart_order_number || "-"}</strong></span>
            <span>PO # <strong>{selectedOrder.po_number || "-"}</strong></span>
            <span>Status <strong>{selectedOrder.status || "Parsed"}</strong></span>
            <span>Order date <strong>{selectedOrder.order_date || "-"}</strong></span>
            <span>Items <strong>{selectedOrder.items.map((item) => item.product_name).join(", ") || "-"}</strong></span>
            <span>UPC <strong>{selectedOrder.items.map((item) => item.upc).filter(Boolean).join(", ") || "-"}</strong></span>
            <span>Quantity <strong>{selectedOrder.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)}</strong></span>
            <span>Sales <strong>{currency(orderGross(selectedOrder))}</strong></span>
            <span>Shipping / WFS <strong>{currency(shippingOrWfs(selectedOrder))}</strong></span>
            <span>Commission <strong>{currency(commissionTotal(selectedOrder))}</strong></span>
            <span>COGS <strong>{currency(orderCogs(selectedOrder, inventory))}</strong></span>
            <span>Refunds <strong>{currency(orderRefunds(selectedOrder))}</strong></span>
            <span>Profit <strong>{currency(orderProfit(selectedOrder, inventory))}</strong></span>
          </div>
        </div>
      )}
    </section>
  );
}

function InventorySnapshot({ inventory }: { inventory: InventoryItem[] }) {
  return (
    <section className="table-card">
      <div className="card-heading"><h2>Inventory Snapshot</h2><button className="tiny-button">View All</button></div>
      <table>
        <thead><tr><th>UPC</th><th>Item</th><th>On Hand</th><th>Unit Cost</th><th>Status</th></tr></thead>
        <tbody>
          {inventory.map((item) => {
            const status = item.needs_cost ? "Needs Cost" : item.quantity_on_hand <= 0 ? "Out of Stock" : item.quantity_on_hand <= item.reorder_point ? "Low Stock" : "In Stock";
            return (
              <tr key={item.id}>
                <td>{item.upc}</td>
                <td>{item.product_name}</td>
                <td>{item.quantity_on_hand}</td>
                <td>{item.unit_cost ? currency(item.unit_cost) : "-"}</td>
                <td><span className={statusClass(status)}>{status}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function ProfitSummary({ metrics }: { metrics: ReturnType<typeof dashboardMetrics> }) {
  return (
    <section className="chart-card">
      <div className="card-heading"><h2>Profit Summary</h2></div>
      <div className="report-line"><span>Gross Revenue</span><strong>{currency(metrics.grossRevenue)}</strong></div>
      <div className="report-line"><span>Total Fees</span><strong>-{currency(metrics.walmartFees)}</strong></div>
      <div className="report-line"><span>Shipping Costs</span><strong>-{currency(metrics.shippingCosts)}</strong></div>
      <div className="report-line"><span>COGS</span><strong>-{currency(metrics.totalCogs)}</strong></div>
      <div className="report-total"><span>Net Profit</span><strong>{currency(metrics.netProfit)}</strong></div>
      <div className="report-line"><span>Profit Margin</span><strong>{percent(metrics.grossRevenue ? (metrics.netProfit / metrics.grossRevenue) * 100 : 0)}</strong></div>
    </section>
  );
}

function TopItems({ itemSales }: { itemSales: ReturnType<typeof salesByItem> }) {
  return (
    <section className="table-card">
      <div className="card-heading"><h2>Top Items by Profit</h2><button className="tiny-button">View All</button></div>
      <table>
        <thead><tr><th>Item</th><th>Units</th><th>Profit</th><th>Margin</th></tr></thead>
        <tbody>
          {itemSales.slice(0, 5).map((item) => (
            <tr key={item.name}><td>{item.name}</td><td>{item.units}</td><td>{currency(item.profit)}</td><td>{percent(item.sales ? (item.profit / item.sales) * 100 : 0)}</td></tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function NeedsCostTable({ items }: { items: InventoryItem[] }) {
  return (
    <section className="table-card">
      <div className="card-heading"><h2>Items Needing Cost</h2><button className="tiny-button">View All</button></div>
      <table>
        <thead><tr><th>UPC</th><th>Item</th><th>On Hand</th><th>Status</th></tr></thead>
        <tbody>
          {items.slice(0, 5).map((item) => (
            <tr key={item.id}><td>{item.upc}</td><td>{item.product_name}</td><td>{item.quantity_on_hand}</td><td><span className="badge warning">Needs Cost</span></td></tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ReportCard({ title, value, detail }: { title: string; value: string; detail: string }) {
  return (
    <section className="report-card">
      <span>{title}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </section>
  );
}
