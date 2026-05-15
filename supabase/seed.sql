insert into public.inventory_items (
  upc, sku, product_name, marketplace, walmart_item_id, quantity_on_hand, unit_cost, reorder_point, needs_cost, supplier, notes
) values
  ('645397938446', 'CH-SHR-6', 'Skeeter Hawk Repellent', 'Walmart', '87610234', 42, 2.85, 12, false, 'Cherolee wholesale', 'Seeded from sample Walmart order'),
  ('712345678901', 'CH-MWB', 'Mosquito Wristband', 'Walmart', '87610235', 15, 1.35, 20, false, 'Cherolee wholesale', null),
  ('812345678901', 'CH-CAR2', 'Carabiner 2 Pack', 'Walmart', '87610236', 8, 0.95, 10, false, 'Cherolee wholesale', null),
  ('845678901234', null, 'Travel Size Repellent', 'Walmart', '87610237', 23, 0, 8, true, null, 'Needs cost')
on conflict (upc) do update set
  product_name = excluded.product_name,
  walmart_item_id = excluded.walmart_item_id,
  quantity_on_hand = excluded.quantity_on_hand,
  unit_cost = excluded.unit_cost,
  reorder_point = excluded.reorder_point,
  needs_cost = excluded.needs_cost;

with upserted_order as (
  insert into public.orders (
    po_number, walmart_order_number, marketplace, order_date, ship_by, deliver_by, customer_name,
    status, subtotal, shipping_fee_charged, taxes, customer_total, amount_adjusted
  ) values (
    '119113696422784', '200014533145443', 'Walmart', '2026-05-15', '2026-05-16', '2026-05-20',
    'Z Smith', 'Shipped', 47.94, 0, 3.24, 51.18, 0
  )
  on conflict (po_number) do update set
    walmart_order_number = excluded.walmart_order_number,
    status = excluded.status,
    subtotal = excluded.subtotal,
    taxes = excluded.taxes,
    customer_total = excluded.customer_total
  returning id
),
inv as (
  select id from public.inventory_items where upc = '645397938446'
)
insert into public.order_items (
  order_id, inventory_item_id, upc, product_name, walmart_item_id, quantity, unit_price, subtotal, unit_cost, total_cogs
)
select upserted_order.id, inv.id, '645397938446', 'Skeeter Hawk Repellent', '87610234', 6, 7.99, 47.94, 2.85, 17.10
from upserted_order, inv
on conflict do nothing;

insert into public.order_fees (order_id, fee_type, amount, source, transaction_date, status)
select id, 'Walmart Service Fee', 6.54, 'transaction', '2026-05-15', 'Posted'
from public.orders
where po_number = '119113696422784';

insert into public.shipments (
  order_id, carrier, tracking_number, shipping_status, method, shipping_cost, estimated_delivery
)
select id, 'USPS', '9400111100000000000000', 'Shipped', 'Ground Advantage', 6.54, 'May 18, 2026'
from public.orders
where po_number = '119113696422784';

insert into public.transactions (
  order_id, po_number, transaction_date, transaction_type, item_id, quantity, net_payable, status, raw_text
)
select id, '119113696422784', '2026-05-15', 'Walmart Service Fee', '87610234', 6, -6.54, 'Posted', 'Seeded Walmart Service Fee'
from public.orders
where po_number = '119113696422784';
