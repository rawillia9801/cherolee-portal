Cherolee Walmart Marketplace profit dashboard built with Next.js and Supabase.

## Supabase setup

1. Create a Supabase project.
2. Run `supabase/schema.sql` in the Supabase SQL editor.
3. Optionally run `supabase/seed.sql` to load the sample Walmart order.
4. Copy `.env.example` to `.env.local` and add:

```bash
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

If these values are missing, the app runs in Demo Mode with preview data only. The parser, save path, upsert logic, inventory deduction, and reporting code remain wired for Supabase.

## Development

```bash
npm install
npm run dev
```

The app includes:

- Paste import parsing for Walmart order details and transaction details.
- Editable parse preview before save.
- Supabase upsert by PO number and UPC.
- Auto-created inventory items marked `Needs Cost`.
- Inventory quantity deduction with duplicate-update adjustment.
- Editable item costs that recalculate dashboard profit and reports.
- SQL schema and seed data in `supabase/`.

## Verification

```bash
npm run lint
npm run build
```
