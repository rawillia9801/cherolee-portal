export type InventoryItem = {
  id: string;
  upc: string;
  sku?: string | null;
  product_name: string;
  marketplace?: string | null;
  walmart_item_id?: string | null;
  quantity_on_hand: number;
  unit_cost: number;
  reorder_point: number;
  needs_cost: boolean;
  supplier?: string | null;
  notes?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type Order = {
  id: string;
  po_number: string;
  walmart_order_number?: string | null;
  marketplace: string;
  order_date?: string | null;
  ship_by?: string | null;
  deliver_by?: string | null;
  customer_name?: string | null;
  status?: string | null;
  subtotal: number;
  shipping_fee_charged: number;
  taxes: number;
  customer_total: number;
  amount_adjusted: number;
  created_at?: string;
  updated_at?: string;
};

export type OrderItem = {
  id: string;
  order_id: string;
  inventory_item_id?: string | null;
  upc: string;
  product_name: string;
  walmart_item_id?: string | null;
  quantity: number;
  unit_price: number;
  subtotal: number;
  unit_cost: number;
  total_cogs: number;
  created_at?: string;
};

export type OrderFee = {
  id: string;
  order_id: string;
  fee_type: string;
  amount: number;
  source: string;
  transaction_date?: string | null;
  status?: string | null;
  created_at?: string;
};

export type Shipment = {
  id: string;
  order_id: string;
  carrier?: string | null;
  tracking_number?: string | null;
  shipping_status?: string | null;
  method?: string | null;
  shipping_cost: number;
  estimated_delivery?: string | null;
  label_format?: string | null;
  created_at?: string;
};

export type Transaction = {
  id: string;
  order_id?: string | null;
  po_number: string;
  transaction_date?: string | null;
  transaction_type: string;
  item_id?: string | null;
  quantity: number;
  net_payable: number;
  status?: string | null;
  raw_text?: string | null;
  created_at?: string;
};

export type ParsedOrder = {
  po_number: string;
  walmart_order_number: string;
  product_name: string;
  upc: string;
  item_condition?: string;
  walmart_item_id?: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
  carrier?: string;
  tracking_number?: string;
  shipping_status?: string;
  estimated_delivery?: string;
  shipping_cost: number;
  order_date?: string;
  ship_by?: string;
  deliver_by?: string;
  customer_name?: string;
  shipping_fee_charged: number;
  taxes: number;
  customer_total: number;
  amount_adjusted: number;
  status: string;
};

export type ParsedTransaction = {
  po_number: string;
  transaction_date?: string;
  transaction_type: string;
  item_id?: string;
  quantity: number;
  net_payable: number;
  status?: string;
  raw_text: string;
};

export type ParsedImport = {
  order: ParsedOrder;
  transactions: ParsedTransaction[];
  warnings: string[];
  raw_order_text?: string;
  raw_transaction_text?: string;
};

export type OrderView = Order & {
  items: OrderItem[];
  fees: OrderFee[];
  shipments: Shipment[];
  transactions: Transaction[];
};
