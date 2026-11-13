CREATE TABLE public.orders (
  id uuid PRIMARY KEY
);
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.api_keys (
  id uuid PRIMARY KEY,
  label text NOT NULL
);
