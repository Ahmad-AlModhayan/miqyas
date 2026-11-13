-- All public tables enable row-level security and define explicit policies.
CREATE TABLE public.orders (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  total_cents integer NOT NULL
);

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY orders_owner_select
  ON public.orders
  FOR SELECT
  USING (owner_id = auth.uid());
