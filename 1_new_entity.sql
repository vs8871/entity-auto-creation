CREATE TABLE order_info
( order_id integer CONSTRAINT order_details_pk PRIMARY KEY,
  Product_id integer NOT NULL,
  Delivery_date date,
  quantity integer,
  feedback TEXT
);
