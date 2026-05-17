create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  upc text unique not null,
  sku text,
  partner_item_id text,
  partner_gtin text,
  product_name text not null,
  product_image_url text,
  brand text,
  category text,
  product_type text,
  contract_category text,
  fulfillment_type text,
  marketplace text default 'Walmart',
  walmart_item_id text,
  quantity_on_hand integer not null default 0,
  unit_cost numeric(12,2) not null default 0,
  reorder_point integer not null default 0,
  needs_cost boolean not null default false,
  supplier text,
  location text,
  notes text,
  last_scanned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.inventory_items add column if not exists partner_item_id text;
alter table public.inventory_items add column if not exists partner_gtin text;
alter table public.inventory_items add column if not exists product_image_url text;
alter table public.inventory_items add column if not exists brand text;
alter table public.inventory_items add column if not exists category text;
alter table public.inventory_items add column if not exists product_type text;
alter table public.inventory_items add column if not exists contract_category text;
alter table public.inventory_items add column if not exists fulfillment_type text;
alter table public.inventory_items add column if not exists location text;
alter table public.inventory_items add column if not exists last_scanned_at timestamptz;

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  po_number text unique not null,
  walmart_order_number text,
  marketplace text not null default 'Walmart',
  order_date date,
  ship_by date,
  deliver_by date,
  customer_name text,
  status text,
  subtotal numeric(12,2) not null default 0,
  shipping_fee_charged numeric(12,2) not null default 0,
  taxes numeric(12,2) not null default 0,
  customer_total numeric(12,2) not null default 0,
  amount_adjusted numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  inventory_item_id uuid references public.inventory_items(id) on delete set null,
  upc text,
  product_name text not null,
  walmart_item_id text,
  quantity integer not null default 1,
  unit_price numeric(12,2) not null default 0,
  subtotal numeric(12,2) not null default 0,
  unit_cost numeric(12,2) not null default 0,
  total_cogs numeric(12,2) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.order_fees (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  fee_type text not null,
  amount numeric(12,2) not null default 0,
  source text,
  transaction_date date,
  status text,
  created_at timestamptz not null default now()
);

create table if not exists public.shipments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  carrier text,
  tracking_number text,
  shipping_status text,
  method text,
  shipping_cost numeric(12,2) not null default 0,
  estimated_delivery text,
  label_format text,
  created_at timestamptz not null default now()
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete cascade,
  po_number text not null,
  transaction_date date,
  transaction_type text not null,
  item_id text,
  quantity integer not null default 1,
  net_payable numeric(12,2) not null default 0,
  status text,
  raw_text text,
  created_at timestamptz not null default now()
);

create table if not exists public.imports (
  id uuid primary key default gen_random_uuid(),
  import_type text not null,
  raw_text text,
  parsed_json jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  movement_type text not null check (movement_type in ('scan_add', 'manual_add', 'scan_remove', 'manual_remove', 'sale_deduction', 'return_restock', 'refund_adjustment', 'correction')),
  quantity_change integer not null,
  reason text not null check (reason in ('Added by scan', 'Manual add', 'Sale', 'Gifted', 'Kept', 'Damaged', 'Other', 'Return restock', 'Correction', 'Settlement import')),
  source text not null,
  source_order_id uuid references public.orders(id) on delete set null,
  source_order_number text,
  source_po_number text,
  settlement_import_id uuid references public.imports(id) on delete set null,
  notes text,
  created_by text,
  created_at timestamptz not null default now()
);

drop trigger if exists inventory_items_updated_at on public.inventory_items;
create trigger inventory_items_updated_at
before update on public.inventory_items
for each row execute function public.set_updated_at();

drop trigger if exists orders_updated_at on public.orders;
create trigger orders_updated_at
before update on public.orders
for each row execute function public.set_updated_at();

create index if not exists idx_orders_po_number on public.orders(po_number);
create index if not exists idx_order_items_upc on public.order_items(upc);
create index if not exists idx_transactions_po_number on public.transactions(po_number);
create index if not exists idx_inventory_needs_cost on public.inventory_items(needs_cost);
create index if not exists idx_inventory_lookup on public.inventory_items(upc, sku, partner_item_id, partner_gtin);
create index if not exists idx_inventory_movements_item on public.inventory_movements(inventory_item_id, created_at);

alter table public.inventory_items enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_fees enable row level security;
alter table public.shipments enable row level security;
alter table public.transactions enable row level security;
alter table public.imports enable row level security;
alter table public.inventory_movements enable row level security;

drop policy if exists "dashboard anon full access" on public.inventory_items;
create policy "dashboard anon full access"
on public.inventory_items
for all
to anon
using (true)
with check (true);

drop policy if exists "dashboard anon full access" on public.orders;
create policy "dashboard anon full access"
on public.orders
for all
to anon
using (true)
with check (true);

drop policy if exists "dashboard anon full access" on public.order_items;
create policy "dashboard anon full access"
on public.order_items
for all
to anon
using (true)
with check (true);

drop policy if exists "dashboard anon full access" on public.order_fees;
create policy "dashboard anon full access"
on public.order_fees
for all
to anon
using (true)
with check (true);

drop policy if exists "dashboard anon full access" on public.shipments;
create policy "dashboard anon full access"
on public.shipments
for all
to anon
using (true)
with check (true);

drop policy if exists "dashboard anon full access" on public.transactions;
create policy "dashboard anon full access"
on public.transactions
for all
to anon
using (true)
with check (true);

drop policy if exists "dashboard anon full access" on public.imports;
create policy "dashboard anon full access"
on public.imports
for all
to anon
using (true)
with check (true);

drop policy if exists "dashboard anon full access" on public.inventory_movements;
create policy "dashboard anon full access"
on public.inventory_movements
for all
to anon
using (true)
with check (true);
