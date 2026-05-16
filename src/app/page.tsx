"use client";

import {
  AlertTriangle,
  Archive,
  BarChart3,
  Boxes,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  ClipboardPaste,
  Database,
  Download,
  Edit3,
  Home as HomeIcon,
  Menu,
  PackagePlus,
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
import { useCallback, useEffect, useMemo, useState } from "react";
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
import {
  currency,
  dashboardMetrics,
  feeBreakdown,
  orderCogs,
  orderFees,
  orderGross,
  orderMargin,
  orderProfit,
  orderShipping,
  percent,
  profitTrend,
  salesByItem,
} from "@/lib/calculations";
import { demoInventory, demoOrders, sampleOrderPaste } from "@/lib/demo-data";
import { parseWalmartImport } from "@/lib/parser";
import {
  deleteOrderRecord,
  isSupabaseConfigured,
  loadDashboardData,
  saveParsedImport,
  updateInventoryItem,
  updateOrderRecord,
  type OrderEditInput,
} from "@/lib/supabase";
import type { InventoryItem, OrderView, ParsedImport, ParsedOrder } from "@/lib/types";

const views = [
  { id: "dashboard", label: "Dashboard", icon: HomeIcon },
  { id: "import", label: "Paste Import", icon: ClipboardPaste },
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

export default function Home() {
  const configured = isSupabaseConfigured();
  const [activeView, setActiveView] = useState<ViewId>("dashboard");
  const [orders, setOrders] = useState<OrderView[]>(demoOrders);
  const [inventory, setInventory] = useState<InventoryItem[]>(demoInventory);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [orderText, setOrderText] = useState(sampleOrderPaste);
  const [transactionText, setTransactionText] = useState("");
  const [preview, setPreview] = useState<ParsedImport | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!configured) {
      setOrders(demoOrders);
      setInventory(demoInventory);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await loadDashboardData();
      setOrders(data.orders);
      setInventory(data.inventory);
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
    setMessage(parsed.warnings.length ? parsed.warnings.join(" ") : "Preview parsed. Review fields, then save.");
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
      await saveParsedImport(preview);
      setMessage(`Saved PO ${preview.order.po_number} to Supabase and refreshed the dashboard.`);
      setPreview(null);
      await refresh();
      setActiveView("dashboard");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const updateCost = async (item: InventoryItem, value: string) => {
    const unitCost = Number(value);
    if (!configured) {
      setInventory((current) =>
        current.map((candidate) =>
          candidate.id === item.id ? { ...candidate, unit_cost: unitCost, needs_cost: !unitCost } : candidate,
        ),
      );
      setMessage("Demo Mode cost updated locally for preview. Supabase is required for persistence.");
      return;
    }
    await updateInventoryItem(item.id, { unit_cost: unitCost });
    await refresh();
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

  const mainTitle = views.find((view) => view.id === activeView)?.label ?? "Dashboard";

  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand">Cherolee</div>
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
            <ClipboardPaste size={16} />
            Paste New Order
          </button>
          <button className="quick-action" onClick={() => setActiveView("inventory")}>
            <PackagePlus size={16} />
            Add Inventory Item
          </button>
        </div>

        <div className="sidebar-block">
          <p>Alerts</p>
          <div className="alert-row"><AlertTriangle size={15} /> Items needing cost <strong>{metrics.needsCost}</strong></div>
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
            <p>Track Walmart sales, fees, costs and profit.</p>
          </div>
          <div className="top-actions">
            {!configured && <span className="demo-pill"><Database size={14} /> Demo Mode</span>}
            <button className="filter-button"><CalendarDays size={15} /> May 1 - May 15, 2026</button>
            <button className="filter-button">Compare</button>
            <button className="export-button"><Download size={15} /> Export Report</button>
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
          />
        )}

        {activeView === "orders" && (
          <OrdersView orders={orders} inventory={inventory} onEditOrder={editOrder} onDeleteOrder={deleteOrder} />
        )}
        {activeView === "inventory" && <InventoryView inventory={inventory} orders={orders} updateCost={updateCost} />}
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
}) {
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

  return (
    <section className="import-layout">
      <div className="paste-card">
        <div className="card-heading"><h2>Walmart Order Details Paste</h2></div>
        <textarea value={props.orderText} onChange={(event) => props.setOrderText(event.target.value)} />
      </div>
      <div className="paste-card">
        <div className="card-heading"><h2>Walmart Transactions Paste</h2><span>Optional. Fee auto-calculates at 15%.</span></div>
        <textarea
          value={props.transactionText}
          placeholder="Optional. Leave blank to auto-calculate Walmart commission at 15%."
          onChange={(event) => props.setTransactionText(event.target.value)}
        />
      </div>
      <div className="import-actions">
        <button className="export-button" onClick={props.parsePreview}><Search size={16} /> Parse Preview</button>
        <button className="filter-button" onClick={props.savePreview} disabled={!props.preview || props.saving}>
          <CheckCircle2 size={16} /> {props.saving ? "Saving..." : "Confirm and Save"}
        </button>
      </div>

      {props.preview && (
        <div className="preview-card">
          <div className="card-heading"><h2>Editable Parse Preview</h2><span>Duplicate detection: PO number</span></div>
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
          <div className="transaction-preview">
            <h3>Transactions</h3>
            {props.preview.transactions.map((transaction, index) => (
              <div key={`${transaction.transaction_type}-${index}`}>
                <span>{transaction.transaction_type}</span>
                <strong>{currency(transaction.net_payable)}</strong>
                <em>{transaction.status || "Parsed"}</em>
              </div>
            ))}
          </div>
        </div>
      )}
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
}: {
  orders: OrderView[];
  inventory: InventoryItem[];
  onEditOrder: (order: OrderView, input: OrderEditInput) => Promise<void>;
  onDeleteOrder: (order: OrderView) => Promise<void>;
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
              {currency(orderProfit(orders[0], inventory))} = {currency(orderGross(orders[0]))} - {currency(orderFees(orders[0]))} - {currency(orderShipping(orders[0]))} - {currency(orderCogs(orders[0], inventory))}
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
  const refunds = order.transactions.filter((transaction) => /refund/i.test(transaction.transaction_type || transaction.status || ""));
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

function InventoryView({
  inventory,
  orders,
  updateCost,
}: {
  inventory: InventoryItem[];
  orders: OrderView[];
  updateCost: (item: InventoryItem, value: string) => void;
}) {
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  const selectedStats = selectedItem ? inventoryStats(selectedItem, orders, inventory) : null;

  return (
    <div className="page-stack">
      <section className="table-card full">
        <div className="card-heading"><h2>Inventory</h2><button className="tiny-button">Add Item</button></div>
        <table>
          <thead><tr><th>UPC</th><th>Item</th><th>SKU</th><th>On Hand</th><th>Unit Cost</th><th>Units Sold</th><th>Profit</th><th>Reorder</th><th>Supplier</th><th>Status</th></tr></thead>
          <tbody>
            {inventory.map((item) => {
              const stats = inventoryStats(item, orders, inventory);
              return (
                <tr key={item.id} className="clickable-row" onClick={() => setSelectedItem(item)}>
                  <td>{item.upc}</td>
                  <td>{item.product_name}</td>
                  <td>{item.sku || "-"}</td>
                  <td>{item.quantity_on_hand}</td>
                  <td>
                    <input
                      className="cost-input"
                      defaultValue={item.unit_cost}
                      onClick={(event) => event.stopPropagation()}
                      onBlur={(event) => updateCost(item, event.target.value)}
                    />
                  </td>
                  <td>{stats.unitsSold}</td>
                  <td className={stats.profit >= 0 ? "profit-positive" : "profit-negative"}>{currency(stats.profit)}</td>
                  <td>{item.reorder_point}</td>
                  <td>{item.supplier || "-"}</td>
                  <td><span className={statusClass(item.needs_cost ? "Needs Cost" : item.quantity_on_hand <= item.reorder_point ? "Low Stock" : "In Stock")}>{item.needs_cost ? "Needs Cost" : item.quantity_on_hand <= item.reorder_point ? "Low Stock" : "In Stock"}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {selectedItem && selectedStats && (
        <section className="item-summary-card">
          <div className="card-heading">
            <div>
              <h2>{selectedItem.product_name}</h2>
              <span>UPC {selectedItem.upc}</span>
            </div>
            <button className="tiny-button" onClick={() => setSelectedItem(null)}>Close</button>
          </div>

          <div className="item-summary-grid">
            <ReportCard title="Units Sold" value={String(selectedStats.unitsSold)} detail="Across saved orders" />
            <ReportCard title="Seller Proceeds" value={currency(selectedStats.gross)} detail="Before commission, shipping, COGS" />
            <ReportCard title="Total Profit" value={currency(selectedStats.profit)} detail="Proceeds - fees - shipping - COGS - refunds" />
            <ReportCard title="Refunds" value={currency(selectedStats.refunds)} detail="Refund transactions found" />
          </div>

          <div className="formula item-formula">
            <strong>Profit formula for this item</strong>
            <span>{currency(selectedStats.profit)} = {currency(selectedStats.gross)} - {currency(selectedStats.fees)} fees - {currency(selectedStats.shipping)} shipping - {currency(selectedStats.cogs)} COGS - {currency(selectedStats.refunds)} refunds</span>
          </div>

          <div className="table-card embedded">
            <div className="card-heading"><h2>Orders and Refunds</h2></div>
            <table>
              <thead><tr><th>PO / Order</th><th>Date</th><th>Customer</th><th>Qty</th><th>Proceeds</th><th>Fees</th><th>Shipping</th><th>COGS</th><th>Refunds</th><th>Profit</th><th>Status</th></tr></thead>
              <tbody>
                {selectedStats.rows.map((row) => (
                  <tr key={`${row.order.id}-${row.item.id}`}>
                    <td>{row.order.po_number}</td>
                    <td>{row.order.order_date || "-"}</td>
                    <td>{row.order.customer_name || "-"}</td>
                    <td>{row.item.quantity}</td>
                    <td>{currency(row.itemGross)}</td>
                    <td>{currency(row.fees)}</td>
                    <td>{currency(row.shipping)}</td>
                    <td>{currency(row.cogs)}</td>
                    <td>{currency(row.refundTotal)}</td>
                    <td className={row.profit >= 0 ? "profit-positive" : "profit-negative"}>{currency(row.profit)}</td>
                    <td><span className={statusClass(row.refundTotal ? "Refund" : row.order.status)}>{row.refundTotal ? "Refund" : row.order.status || "Parsed"}</span></td>
                  </tr>
                ))}
                {!selectedStats.rows.length && (
                  <tr><td colSpan={11}>No saved orders or refunds found for this UPC yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
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
  return (
    <section className={clsx("table-card", compact && "wide")}>
      <div className="card-heading"><h2>Recent Orders</h2><button className="tiny-button">View All</button></div>
      <table>
        <thead><tr><th>PO #</th><th>Order #</th><th>Date</th><th>Customer</th><th>Items</th><th>Total</th><th>Fees</th><th>Profit</th><th>Status</th>{(onEdit || onDelete) && <th>Actions</th>}</tr></thead>
        <tbody>
          {orders.map((order) => (
            <tr key={order.id}>
              <td>{order.po_number}</td>
              <td>{order.walmart_order_number}</td>
              <td>{order.order_date}</td>
              <td>{order.customer_name}</td>
              <td>{order.items.length}</td>
              <td>{currency(order.customer_total)}</td>
              <td>{currency(orderFees(order))}</td>
              <td>{currency(orderProfit(order, inventory))}</td>
              <td><span className={statusClass(order.status)}>{order.status || "Parsed"}</span></td>
              {(onEdit || onDelete) && (
                <td>
                  <div className="row-actions">
                    {onEdit && <button className="icon-button" onClick={() => onEdit(order)} title="Edit order"><Edit3 size={14} /></button>}
                    {onDelete && (
                      <button
                        className="icon-button danger"
                        onClick={() => void onDelete(order).catch((error) => {
                          window.alert(error instanceof Error ? error.message : "Order delete failed.");
                        })}
                        title="Delete order"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
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
