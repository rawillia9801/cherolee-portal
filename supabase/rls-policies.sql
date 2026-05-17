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
