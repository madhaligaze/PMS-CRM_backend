CREATE TABLE "cash_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" bigint NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_shift_id_cash_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."cash_shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_movements_shift_idx" ON "cash_movements" USING btree ("shift_id");--> statement-breakpoint
ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_amount_chk CHECK (amount > 0);
--> statement-breakpoint
ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_kind_chk CHECK (kind IN ('withdrawal', 'deposit'));
--> statement-breakpoint
-- Выемка и внесение - кассовые документы: только в открытую смену, без правок и удаления.
CREATE TRIGGER cash_movements_open_shift BEFORE INSERT ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION payments_require_open_shift();
--> statement-breakpoint
CREATE TRIGGER cash_movements_append_only BEFORE UPDATE OR DELETE ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
